FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /tests
COPY package*.json ./
RUN npm ci --omit=dev
COPY *.mjs ./
CMD ["npm", "run", "acceptance"]
