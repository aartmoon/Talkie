FROM node:22-alpine AS builder
WORKDIR /src/frontend

ARG VITE_API_BASE_URL=http://localhost:8080
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

COPY package.json ./
RUN npm install --no-fund --no-audit

COPY . ./
RUN npm run build

FROM nginx:1.27-alpine
WORKDIR /usr/share/nginx/html

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /src/frontend/dist ./

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
