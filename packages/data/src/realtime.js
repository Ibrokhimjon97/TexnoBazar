import { getBrowserClient } from './auth.js';
let sequence=0;
export function subscribeTable({table,event='*',schema='public',filter,onChange,onError}){const channel=getBrowserClient().channel(`tnb-${table}-${Date.now()}-${++sequence}`);channel.on('postgres_changes',{event,schema,table,...(filter?{filter}:{})},payload=>onChange?.(payload)).subscribe(status=>{if(status==='CHANNEL_ERROR'||status==='TIMED_OUT')onError?.(new Error(`${table} realtime ulanishi: ${status}`))});return()=>{getBrowserClient().removeChannel(channel)}}
export const subscribeInventory=(onChange,onError)=>subscribeTable({table:'inventory_balances',onChange,onError});
export const subscribeOrders=(onChange,onError,branchId=null)=>subscribeTable({table:'orders',filter:branchId?`branch_id=eq.${branchId}`:undefined,onChange,onError});
export const subscribeDeliveries=(onChange,onError,courierId=null)=>subscribeTable({table:'deliveries',filter:courierId?`courier_id=eq.${courierId}`:undefined,onChange,onError});
export const subscribeNotifications=(onChange,onError,recipientId)=>subscribeTable({table:'notifications',filter:`recipient_id=eq.${recipientId}`,onChange,onError});
export const subscribePosPendingSales=(onChange,onError,branchId=null)=>subscribeTable({table:'pos_pending_sales',filter:branchId?`branch_id=eq.${branchId}`:undefined,onChange,onError});
export function subscribeCms(onChange, onError) {
  const tables = ['cms_banners', 'cms_home_blocks', 'cms_promotions', 'cms_promotion_products', 'products'];
  const channel = getBrowserClient().channel(`tnb-cms-${Date.now()}-${++sequence}`);
  for (const table of tables) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, payload => onChange?.(payload));
  }
  channel.subscribe(status => {
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      onError?.(new Error(`CMS realtime ulanishi: ${status}`));
    }
  });
  return () => {
    getBrowserClient().removeChannel(channel);
  };
}
