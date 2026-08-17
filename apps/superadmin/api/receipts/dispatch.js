import{timingSafeEqual}from'node:crypto';
import{sendReceiptEmail}from'@texnobazar/server/receipt-email';
import{createServerSupabase,sendJson}from'../_lib/auth.js';

function authorized(req){const expected=String(process.env.NOTIFICATION_CRON_SECRET||process.env.CRON_SECRET||''),header=Array.isArray(req.headers?.authorization)?req.headers.authorization[0]:req.headers?.authorization,actual=String(header||'').replace(/^Bearer\s+/i,'');if(!expected||!actual)return false;const a=Buffer.from(actual),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b)}
async function finish(admin,item,outcome,providerId=null,error=null){const result=await admin.rpc('finish_receipt_delivery',{p_delivery_id:item.id,p_lock_token:item.lock_token,p_outcome:outcome,p_provider_message_id:providerId,p_error:error});if(result.error)throw result.error}

export default async function handler(req,res){
  if(!['GET','POST'].includes(req.method))return sendJson(res,405,{error:'Method not allowed'});
  if(!authorized(req))return sendJson(res,401,{error:'Unauthorized'});
  const apiKey=process.env.RESEND_API_KEY,from=process.env.RECEIPT_FROM_EMAIL;
  if(!apiKey||!from)return sendJson(res,503,{error:'Receipt email provider is not configured'});
  try{
    const admin=createServerSupabase(),claim=await admin.rpc('claim_receipt_delivery_batch',{p_limit:20});
    if(claim.error)throw claim.error;
    const stats={sent:0,retry:0,dead:0,ambiguous:0,persistence_failed:0};
    for(const item of claim.data||[]){
      let provider;
      try{
        provider=await sendReceiptEmail({apiKey,from,to:item.recipient_email,payload:item.receipt_payload,idempotencyKey:`receipt-${item.idempotency_key}`});
      }catch(error){
        const outcome=error?.ambiguous?'ambiguous':error?.retryable?'retry':'dead';
        try{await finish(admin,item,outcome,null,String(error?.message||'Receipt provider error').slice(0,1000));stats[outcome]++}
        catch(finishError){stats.persistence_failed++;console.error('Receipt provider xatosi holatini saqlab bo‘lmadi.')}
        continue;
      }
      try{await finish(admin,item,'sent',provider.id,null);stats.sent++}
      catch(finishError){stats.persistence_failed++;console.error('Qabul qilingan receipt delivery holatini saqlab bo‘lmadi.')}
    }
    return sendJson(res,200,{ok:true,claimed:(claim.data||[]).length,...stats});
  }catch(error){console.error('Receipt delivery worker error');return sendJson(res,500,{error:'Receipt delivery worker failed'})}
}
