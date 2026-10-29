import { getBrowserClient } from './auth.js';
let sequence=0;
export function subscribeTable({table,event='*',schema='public',filter,onChange,onError}){const channel=getBrowserClient().channel(`tnb-${table}-${Date.now()}-${++sequence}`);channel.on('postgres_changes',{event,schema,table,...(filter?{filter}:{})},payload=>onChange?.(payload)).subscribe(status=>{if(status==='CHANNEL_ERROR'||status==='TIMED_OUT')onError?.(new Error(`${table} realtime ulanishi: ${status}`))});return()=>{getBrowserClient().removeChannel(channel)}}
export const subscribeInventory=(onChange,onError)=>subscribeTable({table:'inventory_balances',onChange,onError});
export const subscribeOrders=(onChange,onError,branchId=null)=>subscribeTable({table:'orders',filter:branchId?`branch_id=eq.${branchId}`:undefined,onChange,onError});
export const subscribeDeliveries=(onChange,onError,courierId=null)=>subscribeTable({table:'deliveries',filter:courierId?`courier_id=eq.${courierId}`:undefined,onChange,onError});
export const subscribeNotifications=(onChange,onError,recipientId)=>subscribeTable({table:'notifications',filter:`recipient_id=eq.${recipientId}`,onChange,onError});
const posChannels = new Map();

/**
 * POS pending sales uchun barqaror multiplexed kanal:
 * 1. Broadcast (mijozlar o'rtasida to'g'ridan-to'g'ri WebSocket orqali < 50ms)
 * 2. Postgres changes (REPLICA IDENTITY FULL orqali bazadagi o'zgarishlar)
 * 3. Bir nechta komponent (App.jsx + CashWorkspace.jsx) bitta umumiy kanaldan foydalanadi
 */
export function subscribePosPendingSales(onChange, onError, branchId = null) {
  const branchKey = branchId ? String(branchId) : 'all';
  let entry = posChannels.get(branchKey);

  if (entry?.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = null;
  }

  if (!entry) {
    const client = getBrowserClient();
    const channelName = `pos-sales-${branchKey}`;
    const channel = client.channel(channelName, {
      config: {
        broadcast: { ack: false }
      }
    });

    entry = {
      channel,
      listeners: new Set(),
      refCount: 0,
      cleanupTimer: null
    };
    posChannels.set(branchKey, entry);

    const notify = (payload) => {
      for (const listener of entry.listeners) {
        try {
          listener(payload);
        } catch (e) {
          console.error('POS listener error:', e);
        }
      }
    };

    // 1. Tezkor client broadcast (< 50ms, bazaga so'rov yubormaydi)
    channel.on('broadcast', { event: 'pos_sale_update' }, (msg) => {
      notify({ eventType: 'BROADCAST', source: 'broadcast', ...msg });
    });

    // 2. PostgreSQL CDC (REPLICA IDENTITY FULL orqali)
    const filter = branchId ? `branch_id=eq.${branchId}` : undefined;
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'pos_pending_sales', ...(filter ? { filter } : {}) },
      (payload) => {
        notify({ eventType: 'POSTGRES', source: 'cdc', ...payload });
      }
    );

    channel.subscribe((status, err) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`pos_pending_sales [${branchKey}] realtime ulanish holati:`, status, err);
        onError?.(new Error(`POS realtime ulanishi: ${status}`));
      }
    });
  }

  if (onChange) {
    entry.listeners.add(onChange);
  }
  entry.refCount++;

  return () => {
    if (onChange) {
      entry.listeners.delete(onChange);
    }
    entry.refCount--;

    if (entry.refCount <= 0) {
      // 5 soniya kutib keyin yopadi, tezkor re-render / tab o'zgarishida uzilib qolmaydi
      entry.cleanupTimer = setTimeout(() => {
        try {
          getBrowserClient().removeChannel(entry.channel);
        } catch (err) {
          console.warn('removeChannel xatosi:', err);
        }
        posChannels.delete(branchKey);
      }, 5000);
    }
  };
}

/**
 * Savdo yaratilganda, o'zgartirilganda yoki tasdiqlanganda zudlik bilan barcha tinglovchilarga broadcast yuborish.
 * Bu Supabase limitini mutlaqo yemaydi (0 REST so'rov) va 20-50ms da kassaga yetib boradi.
 */
export async function broadcastPosPendingSale(branchId, payload = {}) {
  try {
    const client = getBrowserClient();
    if (!client) return;

    const keys = [branchId ? String(branchId) : 'all'];
    if (branchId) keys.push('all');

    for (const key of keys) {
      const channelName = `pos-sales-${key}`;
      let channel = client.getChannels().find(c => c.topic === `realtime:${channelName}`);
      if (!channel) {
        channel = client.channel(channelName, { config: { broadcast: { ack: false } } });
      }

      const msg = {
        type: 'broadcast',
        event: 'pos_sale_update',
        payload: {
          branchId,
          timestamp: Date.now(),
          ...payload
        }
      };

      if (channel.state === 'joined') {
        channel.send(msg);
      } else {
        channel.subscribe(status => {
          if (status === 'SUBSCRIBED') {
            channel.send(msg);
          }
        });
      }
    }
  } catch (err) {
    console.warn('broadcastPosPendingSale warning:', err);
  }
}
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
