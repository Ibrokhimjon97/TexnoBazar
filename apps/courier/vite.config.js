import{fileURLToPath,URL}from'node:url';
import{defineConfig,loadEnv}from'vite';
import react from'@vitejs/plugin-react';
import deliveryProofHandler from'./api/media/delivery-proof.js';
const rootEnvDir=fileURLToPath(new URL('../..',import.meta.url));
function courierApi(){return{name:'texnobazar-courier-api-dev',apply:'serve',configureServer(server){const env={...loadEnv(server.config.mode,rootEnvDir,'VITE_SUPABASE_URL'),...loadEnv(server.config.mode,rootEnvDir,'SUPABASE_SECRET_KEY'),...loadEnv(server.config.mode,rootEnvDir,'R2_')};for(const[key,value]of Object.entries(env))if(!process.env[key]&&value)process.env[key]=value;server.middlewares.use(async(req,res,next)=>{const path=new URL(req.url??'/','http://localhost').pathname;if(path!=='/api/media/delivery-proof')return next();await deliveryProofHandler(req,res)})}}}
export default defineConfig({envDir:rootEnvDir,plugins:[courierApi(),react()],server:{hmr:{overlay:false}}});
