import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

function parseEnv(text){const out={};for(const raw of text.split(/\r?\n/u)){const line=raw.trim();if(!line||line.startsWith('#'))continue;const m=/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);if(!m)continue;let value=m[2].trim();if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);out[m[1]]=value}return out}
function args(){const out={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(!key?.startsWith('--')||!process.argv[i+1])throw new Error('Argumentlar: --email, --password, --name');out[key.slice(2)]=process.argv[i+1]}return out}
function validPassword(value){return typeof value==='string'&&value.length>=10&&/[a-z]/.test(value)&&/[A-Z]/.test(value)&&/[0-9]/.test(value)}
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fileEnv=parseEnv(await readFile(resolve(root,'.env.local'),'utf8'));
const env={...fileEnv,...process.env},cli=args();
const email=(cli.email||env.SUPERADMIN_EMAIL||'').trim().toLowerCase();
const password=cli.password||env.SUPERADMIN_PASSWORD||'';
const fullName=(cli.name||env.SUPERADMIN_FULL_NAME||'Super Administrator').trim();
if(!env.VITE_SUPABASE_URL||!env.SUPABASE_SECRET_KEY)throw new Error('Supabase server muhiti sozlanmagan.');
if(!/^\S+@\S+\.\S+$/.test(email))throw new Error('Yaroqli --email talab qilinadi.');
if(!validPassword(password))throw new Error('Parol kamida 10 belgi, katta/kichik harf va raqamdan iborat bo‘lsin.');
if(fullName.length<3||fullName.length>160)throw new Error('Ism 3-160 belgi oralig‘ida bo‘lsin.');
const admin=createClient(env.VITE_SUPABASE_URL,env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
async function findUser(){for(let page=1;;page++){const{data,error}=await admin.auth.admin.listUsers({page,perPage:200});if(error)throw error;const found=data.users.find(u=>u.email?.toLowerCase()===email);if(found)return found;if(data.users.length<200)return null}}
let user=await findUser();
if(!user){const{data,error}=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{full_name:fullName,must_change_password:true}});if(error)throw error;user=data.user;console.log('Superadmin auth foydalanuvchisi yaratildi.')}else console.log('Mavjud auth foydalanuvchisi topildi.');
const{error:profileError}=await admin.from('profiles').upsert({id:user.id,email,full_name:fullName,is_active:true},{onConflict:'id'});if(profileError)throw profileError;
const{data:role,error:lookupError}=await admin.from('profile_roles').select('id').eq('profile_id',user.id).eq('role','superadmin').is('branch_id',null).maybeSingle();if(lookupError)throw lookupError;
if(!role){const{error}=await admin.from('profile_roles').insert({profile_id:user.id,role:'superadmin',branch_id:null});if(error)throw error}
console.log('Superadmin profili va roli tayyor.');
