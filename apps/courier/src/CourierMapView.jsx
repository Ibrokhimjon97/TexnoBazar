import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Navigation,
  Phone,
  ExternalLink,
  MapPin,
  Copy,
  Check,
  Compass,
  AlertCircle,
  Info,
  Package
} from 'lucide-react';
import { formatMoney } from '@texnobazar/ui';

const DEFAULT_CENTER = [41.311081, 69.240562]; // Toshkent markazi (GPS hali olinmagan bo‘lsa)

export function CourierMapView({ myCoords, deliveries = [], onSelectDelivery, onGoToOrders }) {
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const myMarkerRef = useRef(null);
  const myCircleRef = useRef(null);
  const hasCenteredRef = useRef(false);

  const [copiedId, setCopiedId] = useState(null);

  // Faol buyurtmalar (yetkazilayotganlar)
  const activeDeliveries = deliveries.filter(
    d => d.delivery_status !== 'delivered' && d.delivery_status !== 'cancelled'
  );

  // Leaflet xaritasini boshlash
  useEffect(() => {
    if (!mapContainerRef.current) return;

    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    const initialCenter = myCoords
      ? [myCoords.latitude, myCoords.longitude]
      : DEFAULT_CENTER;

    const map = L.map(mapContainerRef.current, {
      center: initialCenter,
      zoom: myCoords ? 15 : 12,
      zoomControl: true
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
      myMarkerRef.current = null;
      myCircleRef.current = null;
    };
  }, []);

  // Faqat kuryerning o‘zining real GPS joylashuvini ko‘rsatish va yangilash
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !myCoords) return;

    const latLng = [myCoords.latitude, myCoords.longitude];

    const myIcon = L.divIcon({
      className: 'custom-my-gps-marker',
      html: '<div class="my-gps-pulse-marker"></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11],
      popupAnchor: [0, -14]
    });

    if (myMarkerRef.current) {
      myMarkerRef.current.setLatLng(latLng);
    } else {
      myMarkerRef.current = L.marker(latLng, { icon: myIcon, zIndexOffset: 1000 }).addTo(map);
      myMarkerRef.current.bindPopup(`
        <div style="font-family: inherit; font-size: 13px; text-align: center; padding: 4px;">
          <b style="color: #0284c7; display: block; margin-bottom: 2px;">📍 Sizning joriy joylashuvingiz</b>
          <div style="font-size: 11px; color: #64748b;">
            ${myCoords.latitude.toFixed(5)}, ${myCoords.longitude.toFixed(5)}
          </div>
          ${myCoords.accuracy ? `<div style="font-size: 10.5px; color: #16a34a; font-weight: 700; margin-top: 3px;">Aniqlik: ±${Math.round(myCoords.accuracy)}m</div>` : ''}
        </div>
      `);
    }

    // GPS aniqlik doirasi (accuracy circle)
    const accuracyRadius = Math.max(15, myCoords.accuracy || 20);
    if (myCircleRef.current) {
      myCircleRef.current.setLatLng(latLng);
      myCircleRef.current.setRadius(accuracyRadius);
    } else {
      myCircleRef.current = L.circle(latLng, {
        radius: accuracyRadius,
        color: '#0284c7',
        fillColor: '#38bdf8',
        fillOpacity: 0.15,
        weight: 1.5
      }).addTo(map);
    }

    // Birinchi marta koordinata kelganda xaritani kuryerga avtomatik fokuslash
    if (!hasCenteredRef.current) {
      map.setView(latLng, 16, { animate: true });
      hasCenteredRef.current = true;
    }
  }, [myCoords]);

  // Kuryer o‘z joylashuviga fokuslash tugmasi
  const handleCenterOnMe = () => {
    if (mapInstanceRef.current && myCoords) {
      mapInstanceRef.current.setView([myCoords.latitude, myCoords.longitude], 16, { animate: true });
      if (myMarkerRef.current) {
        myMarkerRef.current.openPopup();
      }
    }
  };

  // Manzilni nusxalash
  const handleCopyAddress = (id, address) => {
    if (!address) return;
    navigator.clipboard.writeText(address);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* GPS Holati va Bildirishnoma */}
      <div style={{
        background: myCoords ? '#f0fdf4' : '#fffbeb',
        border: `1px solid ${myCoords ? '#bbf7d0' : '#fef08a'}`,
        borderRadius: 12,
        padding: '10px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 8
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: myCoords ? '#16a34a' : '#eab308',
            boxShadow: myCoords ? '0 0 8px #16a34a' : 'none'
          }} />
          <b style={{ fontSize: 12.5, color: myCoords ? '#15803d' : '#854d0e' }}>
            {myCoords ? 'GPS faol — Sizning harakatingiz kuzatilmoqda' : 'GPS signali qidirilmoqda...'}
          </b>
        </div>
        {myCoords && (
          <span style={{ fontSize: 11, color: '#166534', fontFamily: 'monospace' }}>
            {myCoords.latitude.toFixed(4)}, {myCoords.longitude.toFixed(4)} (±{Math.round(myCoords.accuracy || 10)}m)
          </span>
        )}
      </div>

      {/* Tushuntirish Banderoli: Nega xaritada mijozlar belgilanmaydi */}
      <div style={{
        background: '#eff6ff',
        border: '1px solid #bfdbfe',
        borderRadius: 12,
        padding: '10px 13px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 9,
        color: '#1e40af',
        fontSize: 12,
        lineHeight: 1.45
      }}>
        <Info size={17} style={{ flexShrink: 0, marginTop: 1, color: '#2563eb' }} />
        <div>
          <b>Og‘zaki manzillar tartibi:</b> Mijozlar aniq geotochka yubormasdan, og‘zaki manzil aytishgani sababli xaritada noaniq yoki soxta nuqtalar belgilanmaydi. Xaritada faqat sizning real joylashuvingiz ko‘rinadi. Mijoz manziliga borish uchun pastdagi buyurtmalar kartasidan <b>Google</b> yoki <b>Yandex</b> navigator tugmasini bosing.
        </div>
      </div>

      {/* Xarita qismi */}
      <div style={{
        position: 'relative',
        width: '100%',
        height: 380,
        borderRadius: 16,
        overflow: 'hidden',
        border: '1px solid #cbd5e1',
        boxShadow: '0 4px 14px rgba(15,23,42,0.08)'
      }}>
        <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />

        {/* Mening joylashuvimga o‘tish tugmasi */}
        {myCoords ? (
          <button
            type="button"
            onClick={handleCenterOnMe}
            style={{
              position: 'absolute',
              bottom: 18,
              right: 18,
              zIndex: 1000,
              background: '#0f172a',
              color: '#ffffff',
              border: 'none',
              borderRadius: 12,
              padding: '9px 14px',
              fontSize: 12,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
              cursor: 'pointer'
            }}
          >
            <Compass size={16} color="#38bdf8" />
            Mening joyimga fokuslash
          </button>
        ) : (
          <div style={{
            position: 'absolute',
            bottom: 18,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            background: 'rgba(15,23,42,0.85)',
            color: '#fff',
            padding: '7px 14px',
            borderRadius: 10,
            fontSize: 11.5,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            backdropFilter: 'blur(6px)'
          }}>
            📍 Geolokatsiya qidirilmoqda…
          </div>
        )}
      </div>

      {/* Og‘zaki manzillar va Navigatsiya ro‘yxati */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h4 style={{ margin: 0, fontSize: 13.5, fontWeight: 800, color: '#0f172a' }}>
            📋 Yetkaziladigan manzillar ro‘yxati ({activeDeliveries.length})
          </h4>
          <span style={{ fontSize: 11, color: '#64748b' }}>
            Og‘zaki aytilgan manzillar
          </span>
        </div>

        {activeDeliveries.length === 0 ? (
          <div style={{
            background: '#f8fafc',
            border: '1px dashed #cbd5e1',
            borderRadius: 12,
            padding: 24,
            textAlign: 'center',
            color: '#64748b',
            fontSize: 12.5
          }}>
            <Package size={26} style={{ margin: '0 auto 8px', color: '#94a3b8' }} />
            <div>Hozircha sizda yetkazilishi kerak bo‘lgan faol buyurtmalar yo‘q.</div>
            {onGoToOrders && (
              <button
                type="button"
                onClick={onGoToOrders}
                style={{
                  marginTop: 12,
                  border: 'none',
                  background: 'linear-gradient(135deg, #f97316, #ea580c)',
                  color: '#fff',
                  borderRadius: 10,
                  padding: '8px 16px',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  boxShadow: '0 2px 8px rgba(249,115,22,0.3)'
                }}
              >
                Buyurtmalarni ko‘rish va qabul qilish
              </button>
            )}
          </div>
        ) : (
          activeDeliveries.map((del, idx) => {
            const isCod = del.payment_type === 'cod' || Number(del.cod_amount) > 0;
            const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(del.delivery_address || '')}`;
            const yandexMapsUrl = `https://yandex.com/maps/?text=${encodeURIComponent(del.delivery_address || '')}`;
            const isCopied = copiedId === del.id;

            return (
              <div
                key={del.id || idx}
                style={{
                  background: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: 14,
                  padding: '13px 14px',
                  boxShadow: '0 2px 8px rgba(15,23,42,0.04)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10
                }}
              >
                {/* Sarlavha: Buyurtma raqami, Mijoz ismi, To‘lov holati */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        background: '#f1f5f9',
                        color: '#475569',
                        padding: '2px 7px',
                        borderRadius: 6,
                        fontSize: 10.5,
                        fontWeight: 800
                      }}>
                        #{del.delivery_no || (idx + 1)}
                      </span>
                      <b style={{ fontSize: 13.5, color: '#0f172a' }}>
                        {del.customer_name || 'Mijoz'}
                      </b>
                    </div>
                    {del.customer_phone && (
                      <div style={{ marginTop: 3 }}>
                        <a
                          href={`tel:${del.customer_phone}`}
                          style={{
                            color: '#0284c7',
                            textDecoration: 'none',
                            fontSize: 12,
                            fontWeight: 700,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4
                          }}
                        >
                          <Phone size={12} />
                          {del.customer_phone}
                        </a>
                      </div>
                    )}
                  </div>

                  {/* To‘lov ko‘rsatkichi */}
                  <div style={{ textAlign: 'right' }}>
                    {isCod ? (
                      <div style={{
                        background: '#fff7ed',
                        border: '1px solid #ffedd5',
                        color: '#c2410c',
                        padding: '3px 8px',
                        borderRadius: 8,
                        fontSize: 11,
                        fontWeight: 800
                      }}>
                        💵 {formatMoney(Number(del.cod_amount))} so‘m
                        <div style={{ fontSize: 9.5, fontWeight: 600, color: '#ea580c' }}>Naqd olinadi</div>
                      </div>
                    ) : (
                      <div style={{
                        background: '#f0fdf4',
                        border: '1px solid #dcfce7',
                        color: '#15803d',
                        padding: '3px 8px',
                        borderRadius: 8,
                        fontSize: 11,
                        fontWeight: 800
                      }}>
                        ✅ To‘langan
                      </div>
                    )}
                  </div>
                </div>

                {/* Og‘zaki manzil blok */}
                <div style={{
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: 10,
                  padding: '9px 11px',
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 10
                }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, flex: 1, minWidth: 0 }}>
                    <MapPin size={15} style={{ flexShrink: 0, marginTop: 2, color: '#ea580c' }} />
                    <div style={{ fontSize: 12, color: '#1e293b', lineHeight: 1.4, wordBreak: 'break-word' }}>
                      <span style={{ fontSize: 10.5, color: '#64748b', display: 'block', fontWeight: 600 }}>
                        Aytilgan og‘zaki manzil:
                      </span>
                      <b>{del.delivery_address || 'Manzil ko‘rsatilmagan'}</b>
                    </div>
                  </div>

                  {del.delivery_address && (
                    <button
                      type="button"
                      onClick={() => handleCopyAddress(del.id, del.delivery_address)}
                      title="Manzilni nusxalash"
                      style={{
                        flexShrink: 0,
                        border: '1px solid #cbd5e1',
                        background: isCopied ? '#dcfce7' : '#ffffff',
                        color: isCopied ? '#166534' : '#475569',
                        borderRadius: 8,
                        padding: '5px 8px',
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4
                      }}
                    >
                      {isCopied ? <Check size={12} color="#16a34a" /> : <Copy size={12} />}
                      {isCopied ? 'Nusxalandi' : 'Nusxa'}
                    </button>
                  )}
                </div>

                {/* Navigatsiya tugmalari */}
                {del.delivery_address && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <a
                      href={googleMapsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        background: '#0284c7',
                        color: '#ffffff',
                        padding: '8px 10px',
                        borderRadius: 9,
                        fontSize: 11.5,
                        fontWeight: 700,
                        textDecoration: 'none'
                      }}
                    >
                      <ExternalLink size={13} />
                      Google Maps
                    </a>

                    <a
                      href={yandexMapsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        background: '#ef4444',
                        color: '#ffffff',
                        padding: '8px 10px',
                        borderRadius: 9,
                        fontSize: 11.5,
                        fontWeight: 700,
                        textDecoration: 'none'
                      }}
                    >
                      <ExternalLink size={13} />
                      Yandex Xarita
                    </a>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
