import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const webPort=Number(process.env.WOODSHED_WEB_PORT??5173),apiPort=Number(process.env.WOODSHED_API_PORT??3000);
export default defineConfig({plugins:[react()],server:{host:"127.0.0.1",port:webPort,strictPort:true,proxy:{"/api":`http://127.0.0.1:${apiPort}`}},build:{rollupOptions:{output:{entryFileNames:"assets/app.js",chunkFileNames:"assets/chunk-[name].js",assetFileNames:"assets/app[extname]"}}},test:{environment:"jsdom",globals:true}});
