using System.Text.Json;

// A public DTO boundary, not a general-purpose JSON proxy. Unknown fields never reach Web.
public static class DialogPublicDto
{
    private const string Envelope = "protocolVersion schemaId nodeId epoch stateVersion snapshotStateVersion lastEventSeq";
    private const string Dialog = "dialogId version title createdAt lastActivityAt state activeRequestId activeAttemptId";
    private const string Request = "requestId dialogId inputMessageId queueSequence version status";
    private const string Attempt = "attemptId dialogId requestId generation version state effectStatus startedAt finishedAt";
    private const string Tool = "toolCallId toolName state startedAt finishedAt detailVersion";
    private const string Receipt = "protocolVersion schemaId commandId commandKind receiptId acceptedAt nodeId eventSeq result blockingReason references";

    public static JsonElement? Project(string nodeId, string[] path, IReadOnlyDictionary<string, string?> query,
        JsonElement body, JsonElement? command)
    {
        try
        {
            Require(body, "nodeId", nodeId);
            if (body.GetProperty("protocolVersion").GetInt32() != 1) return null;
            var schema = body.GetProperty("schemaId").GetString();
            if (schema is not ("harness-wire-v2" or "dialog-view-v1" or "tool-timeline-v1")) return null;
            var isTool = path.Length >= 3 && path[0] == "attempts" && path[2] == "tool-calls";
            if (isTool != (schema == "tool-timeline-v1")) return null;
            var activity = path is ["dialogs", _] || path is ["dialogs"] && query.GetValueOrDefault("view") == "activity";
            if (schema != (isTool ? "tool-timeline-v1" : activity ? "dialog-view-v1" : "harness-wire-v2")) return null;
            Types(body, "protocolVersion:n schemaId:s nodeId:id");

            if (command is { } cmd)
            {
                ValidateReceipt(body);
                Require(body, "commandId", cmd.GetProperty("commandId").GetString()!);
                Require(body, "commandKind", cmd.GetProperty("kind").GetString()!);
                if (cmd.GetProperty("target").TryGetProperty("dialogId", out var dialog))
                    Require(body.GetProperty("references"), "dialogId", dialog.GetString()!);
                if (cmd.GetProperty("kind").GetString() == "attempt.retry")
                    Require(body.GetProperty("references"), "priorAttemptId", cmd.GetProperty("target").GetProperty("attemptId").GetString()!);
                return JsonSerializer.SerializeToElement(Copy(body, Receipt));
            }
            if (path is ["commands", var commandId])
            {
                Types(body, "commandId:id canonicalPayloadHash:s status:s receipt:o");
                Require(body, "status", "accepted");
                var hash = body.GetProperty("canonicalPayloadHash").GetString()!;
                if (hash.Length != 64 || hash.Any(c => !char.IsAsciiHexDigit(c) || char.IsUpper(c))) return null;
                ValidateReceipt(body.GetProperty("receipt"));
                Require(body, "commandId", commandId);
                Require(body.GetProperty("receipt"), "commandId", commandId);
                Require(body.GetProperty("receipt"), "nodeId", nodeId);
                return JsonSerializer.SerializeToElement(Copy(body, Envelope + " commandId canonicalPayloadHash status receipt"));
            }
            if (path is ["identity"])
            {
                Types(body, "schemaSHA256:s registryVersion:n identityEpoch:n capabilities:o adapter:o");
                Types(body.GetProperty("adapter"), "kind:s version:s");
                return JsonSerializer.SerializeToElement(Copy(body, Envelope + " schemaSHA256 registryVersion identityEpoch capabilities adapter"));
            }
            if (path is ["snapshot"])
            {
                Types(body, "epoch:n stateVersion:n lastEventSeq:n capturedAt:s node:o pendingQueue:a activeAttempt:O completeness:s");
                Types(body.GetProperty("node"), "transportAvailability:s engineReadiness:s occupancy:s queuePaused:b queueVersion:n pendingCount:n blockedReasons:a activeAttemptId:I");
                return JsonSerializer.SerializeToElement(Copy(body, Envelope + " capturedAt node pendingQueue activeAttempt completeness"));
            }
            if (path is ["attempts", var eventAttempt, "events"])
            {
                Types(body, "epoch:n snapshotStateVersion:n lastEventSeq:n dialogId:id attemptId:id pageType:s nextCursor:z items:a");
                Require(body, "attemptId", eventAttempt); Require(body, "pageType", "events");
                if (body.GetProperty("items").GetArrayLength() > 100) return null;
                var events = new List<object>();
                foreach (var item in body.GetProperty("items").EnumerateArray())
                {
                    Types(item, "nodeId:id dialogId:id attemptId:id seq:n type:s payload:o");
                    Require(item, "nodeId", nodeId); Require(item, "attemptId", eventAttempt);
                    Require(item, "dialogId", body.GetProperty("dialogId").GetString()!);
                    var type = item.GetProperty("type").GetString();
                    if (type is not ("attempt.failed" or "attempt.interrupted" or "attempt.unknown")) continue;
                    var payload = item.GetProperty("payload");
                    Types(payload, "generation:n effectStatus:s");
                    var effects = payload.GetProperty("effectStatus").GetString();
                    if (effects is not ("none" or "known" or "unknown")) return null;
                    // Error text is provider-controlled even in historical records.
                    // Publish only fixed explanations for a strict code allowlist.
                    var unsupported = type == "attempt.failed" && payload.TryGetProperty("errorCode", out var code) &&
                        code.ValueKind == JsonValueKind.String && code.GetString() == "codex_model_unsupported";
                    events.Add(new { seq = item.GetProperty("seq").GetInt64(), attemptId = eventAttempt,
                        generation = payload.GetProperty("generation").GetInt64(), type, effectStatus = effects,
                        errorCode = unsupported ? "codex_model_unsupported" : type == "attempt.failed" ? "attempt_failed" : type,
                        safeMessage = unsupported ? "Модель Codex недоступна для этой учётной записи. Выберите доступную модель и повторите сообщение."
                            : type == "attempt.failed" ? "Попытка завершилась ошибкой." : type == "attempt.interrupted" ? "Выполнение прервано." : "Исход выполнения неизвестен. Требуется сверка состояния." });
                }
                var projection = Copy(body, Envelope + " dialogId attemptId pageType nextCursor");
                projection["items"] = events;
                return JsonSerializer.SerializeToElement(projection);
            }
            if (path is ["dialogs", var dialogId]) Require(body.GetProperty("dialog"), "dialogId", dialogId);
            if (path is ["requests", var requestId]) Require(body.GetProperty("request"), "requestId", requestId);
            if (path is ["attempts", var attemptId]) Require(body.GetProperty("attempt"), "attemptId", attemptId);
            if (path is ["dialogs", var historyDialog, "history"]) Require(body, "dialogId", historyDialog);
            if (isTool) { Types(body, "dialogId:id requestId:id attemptId:id"); Require(body, "attemptId", path[1]); }
            if (path.Length == 4 && isTool) Require(body.GetProperty("toolCall"), "toolCallId", path[3]);
            if (query.TryGetValue("requestId", out var expectedRequest)) Require(body, "requestId", expectedRequest!);
            if (path is ["attempts"]) Types(body, "dialogId:id requestId:id");

            string? itemFields = null;
            string? pageType = null;
            if (path is ["dialogs"]) { itemFields = Dialog; pageType = "dialogs"; }
            if (path is ["requests"]) { itemFields = Request; pageType = "requests"; }
            if (path is ["attempts"]) { itemFields = Attempt; pageType = "attempts"; }
            if (path is ["dialogs", _, "history"]) { itemFields = "messageId role dialogId sequence version createdAt text disposition commandId requestId attemptId content finishReason"; pageType = "history"; }
            if (path is ["attempts", _, "tool-calls"]) { itemFields = Tool; pageType = "tool_calls"; }
            var result = Copy(body, Envelope + " dialogId requestId attemptId nextCursor pageType dialog request attempt toolCall");
            if (itemFields is not null)
            {
                Types(body, "epoch:n snapshotStateVersion:n lastEventSeq:n nextCursor:z pageType:s items:a");
                Require(body, "pageType", pageType!);
                var items = body.GetProperty("items");
                if (items.ValueKind != JsonValueKind.Array || items.GetArrayLength() > 100) return null;
                result["items"] = items.EnumerateArray().Select(item =>
                {
                    ValidateItem(item, pageType!, activity);
                    if (path is ["dialogs", var d, "history"]) Require(item, "dialogId", d);
                    if (query.TryGetValue("dialogId", out var filterDialog)) Require(item, "dialogId", filterDialog!);
                    if (query.TryGetValue("requestId", out var filterRequest)) Require(item, "requestId", filterRequest!);
                    var fields = pageType == "history" ? item.GetProperty("role").GetString() == "user"
                        ? "messageId role dialogId sequence version createdAt text disposition commandId requestId"
                        : "messageId role dialogId sequence version createdAt attemptId content finishReason" : itemFields;
                    return Copy(item, fields);
                }).ToArray();
            }
            else Types(body, "epoch:n stateVersion:n");
            return JsonSerializer.SerializeToElement(result);
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException or FormatException or ArgumentException)
        { return null; }
    }

    private static void Require(JsonElement value, string key, string expected)
    {
        if (value.GetProperty(key).ValueKind != JsonValueKind.String || value.GetProperty(key).GetString() != expected)
            throw new InvalidOperationException("Public DTO scope mismatch.");
    }

    private static Dictionary<string, object?> Copy(JsonElement source, string fields)
    {
        if (source.ValueKind != JsonValueKind.Object) throw new InvalidOperationException();
        var result = new Dictionary<string, object?>();
        var allowed = fields.Split(' ').ToHashSet(StringComparer.Ordinal);
        foreach (var property in source.EnumerateObject())
        {
            if (!allowed.Contains(property.Name)) continue;
            var value = property.Value;
            object? filtered = value.Clone();
            if (value.ValueKind == JsonValueKind.Object)
                filtered = property.Name switch
                {
                    "dialog" => Item(value, "dialogs", Dialog, value.TryGetProperty("state", out _)), "request" => Item(value, "requests", Request),
                    "attempt" or "activeAttempt" => Item(value, "attempts", Attempt),
                    "toolCall" => ToolDetail(value),
                    "receipt" => Copy(value, Receipt),
                    "references" => Copy(value, "dialogId messageId requestId priorAttemptId"),
                    "adapter" => Copy(value, "kind version"),
                    "capabilities" => Copy(value, "chat events tool_results cancel steer_attached session_resume policy_enforcement"),
                    "node" => Copy(value, "transportAvailability engineReadiness occupancy queuePaused queueVersion pendingCount blockedReasons activeAttemptId"),
                    "content" or "input" or "result" => Content(value),
                    _ => throw new InvalidOperationException("Unexpected public DTO object.")
                };
            else if (value.ValueKind == JsonValueKind.Array)
                filtered = property.Name switch
                {
                    "pendingQueue" => value.EnumerateArray().Select(item => Item(item, "requests", Request)).ToArray(),
                    "outputs" => value.EnumerateArray().Select(item => { Types(item, "index:n stream:s content:o observedAt:s"); return Copy(item, "index stream content observedAt"); }).ToArray(),
                    "blockedReasons" when value.EnumerateArray().All(item => item.ValueKind == JsonValueKind.String) => value.Clone(),
                    _ => throw new InvalidOperationException("Unexpected public DTO array.")
                };
            result.Add(property.Name, filtered);
        }
        return result;
    }

    private static Dictionary<string, object?> Content(JsonElement content)
    {
        Types(content, "kind:s redaction:s truncated:b");
        var kind = content.GetProperty("kind").GetString();
        if (content.GetProperty("redaction").GetString() is not ("none" or "applied" or "unknown") ||
            content.GetProperty("truncated").ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw new InvalidOperationException();
        if (kind != "unavailable" && content.GetProperty("redaction").GetString() == "unknown") throw new InvalidOperationException();
        Types(content, kind switch { "inline" => "content:s", "artifact" => "artifactId:id sizeBytes:n sha256:s", "unavailable" => "reason:s", _ => throw new InvalidOperationException() });
        if (kind == "inline" && System.Text.Encoding.UTF8.GetByteCount(content.GetProperty("content").GetString()!) > 65536) throw new InvalidOperationException();
        if (kind == "unavailable" && content.GetProperty("reason").GetString() is not ("not_observed" or "provider_redacted" or "output_limit" or "unmapped")) throw new InvalidOperationException();
        if (kind == "artifact")
        {
            var hash = content.GetProperty("sha256").GetString()!;
            if (content.GetProperty("sizeBytes").GetInt64() > 16 * 1024 * 1024 || hash.Length != 64 || hash.Any(c => !char.IsAsciiHexDigit(c) || char.IsUpper(c))) throw new InvalidOperationException();
        }
        return Copy(content, kind switch
        {
            "inline" => "kind content redaction truncated",
            "artifact" => "kind artifactId sizeBytes sha256 redaction truncated",
            "unavailable" => "kind reason redaction truncated",
            _ => throw new InvalidOperationException("Invalid SafeContent.")
        });
    }

    private static Dictionary<string, object?> ToolDetail(JsonElement value)
    {
        ValidateItem(value, "tool_calls", false);
        Types(value, "input:o result?:o outputs:a nextOutputCursor:z outputsTruncated?:b");
        return Copy(value, Tool + " input result outputs nextOutputCursor outputsTruncated");
    }
    private static Dictionary<string, object?> Item(JsonElement value, string type, string fields, bool activity = false)
    { ValidateItem(value, type, activity); return Copy(value, fields); }

    private static void ValidateItem(JsonElement value, string type, bool activity)
    {
        Types(value, type switch
        {
            "dialogs" => "dialogId:id version:n title?:s createdAt:s" + (activity ? " lastActivityAt:s state:s activeRequestId?:id activeAttemptId?:id" : ""),
            "requests" => "requestId:id dialogId:id inputMessageId:id queueSequence:n version:n status:s",
            "attempts" => "attemptId:id dialogId:id requestId:id generation:n version:n state:s effectStatus:s startedAt?:s finishedAt?:s",
            "tool_calls" => "toolCallId:id toolName:s state:s startedAt:s finishedAt?:s detailVersion:n",
            "history" => "messageId:id role:s dialogId:id sequence:n version:n createdAt:s",
            _ => throw new InvalidOperationException()
        });
        if (type == "history")
        {
            var role = value.GetProperty("role").GetString();
            if (role == "user") { Types(value, "text:s disposition:s commandId:id requestId:id"); if (value.TryGetProperty("content", out _)) throw new InvalidOperationException(); }
            else if (role == "assistant") { Types(value, "attemptId:id content:o finishReason:s"); if (value.TryGetProperty("text", out _)) throw new InvalidOperationException(); }
            else throw new InvalidOperationException();
        }
        if (type is "requests" or "attempts" or "tool_calls" || type == "dialogs" && activity)
        {
            var state = value.GetProperty(type == "requests" ? "status" : "state").GetString();
            var allowed = type switch
            {
                "tool_calls" => "running succeeded failed unknown",
                "requests" => "queued cancelled dispatching active completed failed interrupted unknown",
                "attempts" => "dispatching running waiting_input stopping completed failed interrupted unknown",
                _ => "idle queued cancelled dispatching active running waiting_input stopping completed failed interrupted unknown"
            };
            if (!allowed.Split(' ').Contains(state)) throw new InvalidOperationException();
        }
        if (type == "attempts" && value.GetProperty("effectStatus").GetString() is not ("none" or "known" or "unknown")) throw new InvalidOperationException();
    }

    private static void ValidateReceipt(JsonElement value)
    {
        Types(value, "protocolVersion:n schemaId:s commandId:id commandKind:s receiptId:id acceptedAt:s nodeId:id eventSeq:n result:s references:o blockingReason?:s");
        Require(value, "schemaId", "harness-wire-v2");
        if (value.GetProperty("protocolVersion").GetInt32() != 1) throw new InvalidOperationException();
        if (value.GetProperty("result").GetString() is not ("admitted" or "applied")) throw new InvalidOperationException();
        Types(value.GetProperty("references"), value.GetProperty("commandKind").GetString() switch
        {
            "dialog.create" => "dialogId:id", "message.enqueue" => "dialogId:id messageId:id requestId:id",
            "attempt.retry" => "priorAttemptId:id requestId:id",
            _ => throw new InvalidOperationException()
        });
    }

    private static void Types(JsonElement value, string specification)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new InvalidOperationException();
        foreach (var field in specification.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = field.Split(':'); var optional = parts[0].EndsWith('?'); var name = parts[0].TrimEnd('?');
            if (!value.TryGetProperty(name, out var item)) { if (optional) continue; throw new InvalidOperationException(); }
            var valid = parts[1] switch
            {
                "s" => item.ValueKind == JsonValueKind.String,
                "id" => item.ValueKind == JsonValueKind.String && Guid.TryParseExact(item.GetString(), "D", out _),
                "n" => item.ValueKind == JsonValueKind.Number && item.TryGetInt64(out var n) && n is >= 0 and <= 9007199254740991,
                "b" => item.ValueKind is JsonValueKind.True or JsonValueKind.False,
                "a" => item.ValueKind == JsonValueKind.Array,
                "o" => item.ValueKind == JsonValueKind.Object,
                "z" => item.ValueKind is JsonValueKind.String or JsonValueKind.Null,
                "O" => item.ValueKind is JsonValueKind.Object or JsonValueKind.Null,
                "I" => item.ValueKind == JsonValueKind.Null || item.ValueKind == JsonValueKind.String && Guid.TryParseExact(item.GetString(), "D", out _),
                _ => false
            };
            if (!valid) throw new InvalidOperationException("Invalid public DTO field.");
        }
    }
}
