# Usa la imagen oficial de Playwright con Chromium y deps incluidas
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

# Crea y usa /app como directorio de trabajo
WORKDIR /app

# Copia package.json y lock primero para cache de dependencias
COPY package*.json ./

# Instala dependencias (sin dev)
RUN npm ci --omit=dev

# Copia el resto del código
COPY . .

# (Opcional) evita reinstalar navegadores: la imagen ya los trae
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Arranca tu server
CMD ["node", "src/index.js"]
