import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  RefreshCw,
  Navigation,
  MapPin,
  Calendar,
  Phone,
  Truck,
  Activity,
  Route as RouteIcon
} from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  getActiveCouriersLiveLocations,
  getCourierDailyRoute
} from '@texnobazar/data';

const DEFAULT_CENTER = [41.311081, 69.240562]; // Tashkent city center
const DEFAULT_ZOOM = 12;

export function CourierLiveTrackingModal({ open, onClose, branchId }) {
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markersRef = useRef(new Map());
  const routePolylineRef = useRef(null);
  const routeDecorationsRef = useRef([]);

  const [couriers, setCouriers] = useState([]);
  const [selectedCourierId, setSelectedCourierId] = useState('all');
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [loading, setLoading] = useState(true);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeData, setRouteData] = useState(null);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);

  // Initialize Leaflet Map
  useEffect(() => {
    if (!open) return;

    // Small delay to ensure modal DOM is painted
    const initTimer = setTimeout(() => {
      if (!mapContainerRef.current) return;

      if (!mapInstanceRef.current) {
        const map = L.map(mapContainerRef.current, {
          center: DEFAULT_CENTER,
          zoom: DEFAULT_ZOOM,
          zoomControl: true
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap'
        }).addTo(map);

        mapInstanceRef.current = map;
      } else {
        mapInstanceRef.current.invalidateSize();
      }
    }, 100);

    return () => {
      clearTimeout(initTimer);
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [open]);

  // Fetch Couriers Live Locations
  const fetchCouriers = async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const data = await getActiveCouriersLiveLocations(branchId);
      const list = Array.isArray(data) ? data : [];
      setCouriers(list);
      setLastUpdated(new Date());
    } catch (e) {
      if (!silent) setError(e.message || 'Kuryerlar joylashuvi yuklanmadi.');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    fetchCouriers();

    // Auto-poll courier live locations (faqat tab ko'rinib turganda har 15s va focusda darhol)
    const tick = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        fetchCouriers(true);
      }
    };
    const interval = setInterval(tick, 30000);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);

    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [open, branchId]);

  // Fetch Route History when a courier or date changes
  useEffect(() => {
    if (!open || selectedCourierId === 'all') {
      setRouteData(null);
      return;
    }

    let isMounted = true;
    const fetchRoute = async () => {
      setRouteLoading(true);
      try {
        const res = await getCourierDailyRoute({
          courierId: selectedCourierId,
          date: selectedDate
        });
        if (isMounted) setRouteData(res);
      } catch (err) {
        console.error('Route history error:', err);
      } finally {
        if (isMounted) setRouteLoading(false);
      }
    };

    fetchRoute();
    return () => {
      isMounted = false;
    };
  }, [open, selectedCourierId, selectedDate]);

  // Render / Update Markers on Map
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !open) return;

    // Filter couriers to display
    const visibleCouriers = selectedCourierId === 'all'
      ? couriers
      : couriers.filter(c => c.courier_id === selectedCourierId);

    // Remove old markers not in visible list
    const currentIds = new Set(visibleCouriers.map(c => c.courier_id));
    markersRef.current.forEach((marker, id) => {
      if (!currentIds.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    });

    const boundsPoints = [];

    visibleCouriers.forEach(courier => {
      const lat = Number(courier.latitude);
      const lng = Number(courier.longitude);
      if (isNaN(lat) || isNaN(lng)) return;

      boundsPoints.push([lat, lng]);

      const isOnline = Boolean(courier.is_online);
      const courierName = courier.courier_name || 'Kuryer';
      const courierPhone = courier.courier_phone || '';
      const todayKm = Number(courier.today_km || 0).toFixed(1);
      const activeCount = courier.active_deliveries_count || 0;

      // Custom Div Icon with Courier Name Badge
      const customIcon = L.divIcon({
        className: 'custom-courier-leaflet-marker',
        html: `
          <div class="courier-map-marker ${isOnline ? 'online' : 'offline'}">
            <div class="courier-map-label">
              <span class="courier-status-dot ${isOnline ? 'online' : 'offline'}"></span>
              <b>${courierName}</b>
            </div>
            <div class="courier-map-bubble">
              <span class="bubble-icon">🚚</span>
            </div>
          </div>
        `,
        iconSize: [120, 60],
        iconAnchor: [60, 52],
        popupAnchor: [0, -50]
      });

      const popupContent = `
        <div style="font-family: inherit; font-size: 13px; line-height: 1.4; min-width: 190px;">
          <div style="font-weight: 800; font-size: 14px; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
            <span>${courierName}</span>
            <span style="font-size: 10.5px; padding: 2px 6px; border-radius: 4px; background: ${isOnline ? '#dcfce7; color: #166534' : '#f1f5f9; color: #64748b'}; font-weight: 700;">
              ${isOnline ? '● Online' : '○ Offline'}
            </span>
          </div>
          ${courierPhone ? `
            <div style="margin-bottom: 6px;">
              <a href="tel:${courierPhone}" style="color: #0284c7; text-decoration: none; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;">
                📞 ${courierPhone}
              </a>
            </div>
          ` : ''}
          <div style="background: #f8fafc; padding: 6px 8px; border-radius: 6px; border: 1px solid #e2e8f0; font-size: 12px; margin-bottom: 8px;">
            <div>Bugungi yo‘l: <b style="color: #0f172a;">${todayKm} km</b></div>
            <div>Faol buyurtmalar: <b style="color: #ea580c;">${activeCount} ta</b></div>
          </div>
          ${courier.updated_at ? `
            <div style="font-size: 11px; color: #64748b;">
              Oxirgi yangilanish: ${new Date(courier.updated_at).toLocaleTimeString('uz-UZ')}
            </div>
          ` : ''}
        </div>
      `;

      if (markersRef.current.has(courier.courier_id)) {
        const marker = markersRef.current.get(courier.courier_id);
        marker.setLatLng([lat, lng]);
        marker.setIcon(customIcon);
        marker.setPopupContent(popupContent);
      } else {
        const marker = L.marker([lat, lng], { icon: customIcon }).addTo(map);
        marker.bindPopup(popupContent);
        markersRef.current.set(courier.courier_id, marker);
      }
    });

    // If viewing all couriers and have points, gently fit bounds
    if (selectedCourierId === 'all' && boundsPoints.length > 0 && !routePolylineRef.current) {
      map.fitBounds(boundsPoints, { padding: [50, 50], maxZoom: 15 });
    } else if (selectedCourierId !== 'all' && boundsPoints.length === 1 && !routePolylineRef.current) {
      map.setView(boundsPoints[0], 15);
    }
  }, [couriers, selectedCourierId, open]);

  // Render Route Polyline on Map
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !open) return;

    // Clean up previous polyline and decorations
    if (routePolylineRef.current) {
      routePolylineRef.current.remove();
      routePolylineRef.current = null;
    }
    routeDecorationsRef.current.forEach(item => item.remove());
    routeDecorationsRef.current = [];

    const points = routeData?.points || [];
    if (!points.length) return;

    const latLngs = points
      .map(p => [Number(p.lat), Number(p.lng)])
      .filter(([lat, lng]) => !isNaN(lat) && !isNaN(lng));

    if (latLngs.length < 2) return;

    // Draw route polyline
    const polyline = L.polyline(latLngs, {
      color: '#0284c7',
      weight: 5,
      opacity: 0.85,
      lineCap: 'round',
      lineJoin: 'round',
      dashArray: null
    }).addTo(map);

    routePolylineRef.current = polyline;

    // Add Start marker (A)
    const startPoint = latLngs[0];
    const startIcon = L.divIcon({
      className: 'custom-route-start-marker',
      html: '<div style="background: #16a34a; color: #fff; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 800; border: 2px solid #fff; box-shadow: 0 2px 6px rgba(0,0,0,0.3);">A</div>',
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
    const startMarker = L.marker(startPoint, { icon: startIcon }).addTo(map);
    startMarker.bindPopup('<b>Marshrut boshi</b><br/>Vaqt: ' + new Date(points[0].time).toLocaleTimeString('uz-UZ'));
    routeDecorationsRef.current.push(startMarker);

    // Add End marker (B) if different from start
    if (latLngs.length > 1) {
      const endPoint = latLngs[latLngs.length - 1];
      const endIcon = L.divIcon({
        className: 'custom-route-end-marker',
        html: '<div style="background: #dc2626; color: #fff; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 800; border: 2px solid #fff; box-shadow: 0 2px 6px rgba(0,0,0,0.3);">B</div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13]
      });
      const endMarker = L.marker(endPoint, { icon: endIcon }).addTo(map);
      endMarker.bindPopup('<b>Oxirgi nuqta</b><br/>Vaqt: ' + new Date(points[points.length - 1].time).toLocaleTimeString('uz-UZ'));
      routeDecorationsRef.current.push(endMarker);
    }

    // Fit map bounds to polyline
    map.fitBounds(polyline.getBounds(), { padding: [50, 50] });
  }, [routeData, open]);

  if (!open) return null;

  const selectedCourier = couriers.find(c => c.courier_id === selectedCourierId);
  const totalKmToday = couriers.reduce((sum, c) => sum + Number(c.today_km || 0), 0);
  const totalActiveOrders = couriers.reduce((sum, c) => sum + Number(c.active_deliveries_count || 0), 0);

  return (
    <div
      className="overlay"
      style={{ zIndex: 1200 }}
      onMouseDown={e => e.target === e.currentTarget && onClose?.()}
    >
      <div
        className="modal"
        style={{
          maxWidth: 960,
          width: '95vw',
          height: '88vh',
          maxHeight: 820,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 16
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 20px',
          background: 'linear-gradient(135deg, #0f172a, #1e293b)',
          color: '#fff',
          borderBottom: '1px solid rgba(255,255,255,0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: 'linear-gradient(135deg, #0284c7, #0369a1)',
              display: 'grid',
              placeItems: 'center'
            }}>
              <Truck size={20} color="#fff" />
            </div>
            <div>
              <b style={{ fontSize: 16, display: 'block' }}>
                Kuryerlarni jonli kuzatish (Real-time GPS)
              </b>
              <small style={{ color: '#94a3b8', fontSize: 11.5 }}>
                Kuryerlarning joylashuvi, xaritadagi harakati va kunlik bosib o‘tgan masofasi
              </small>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => fetchCouriers(false)}
              disabled={loading}
              title="Yangilash"
              style={{
                color: '#fff',
                borderColor: 'rgba(255,255,255,0.2)',
                background: 'rgba(255,255,255,0.08)',
                padding: '6px 12px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6
              }}
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              <span style={{ fontSize: 11.5 }}>Yangilash</span>
            </button>

            <button
              type="button"
              className="icon-btn modal-close-btn"
              onClick={onClose}
              aria-label="Yopish"
              style={{ color: '#fff', background: 'rgba(255,255,255,0.1)' }}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Toolbar / Filters */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          padding: '12px 18px',
          background: '#f8fafc',
          borderBottom: '1px solid var(--line, #e2e8f0)',
          fontSize: 13
        }}>
          {/* Courier Selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700, color: 'var(--navy, #0f172a)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Navigation size={15} color="#0284c7" /> Kuryer:
            </span>
            <select
              value={selectedCourierId}
              onChange={e => setSelectedCourierId(e.target.value)}
              className="input"
              style={{ padding: '6px 12px', fontSize: 13, minWidth: 200, fontWeight: 600 }}
            >
              <option value="all">📍 Barcha kuryerlar ({couriers.length} ta)</option>
              {couriers.map(c => (
                <option key={c.courier_id} value={c.courier_id}>
                  {c.is_online ? '🟢' : '⚪'} {c.courier_name} — {Number(c.today_km || 0).toFixed(1)} km
                </option>
              ))}
            </select>
          </div>

          {/* Date Selector for Polyline Route History */}
          {selectedCourierId !== 'all' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700, color: 'var(--navy, #0f172a)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Calendar size={15} color="#ea580c" /> Sana:
              </span>
              <input
                type="date"
                value={selectedDate}
                onChange={e => setSelectedDate(e.target.value)}
                className="input"
                style={{ padding: '5px 10px', fontSize: 13 }}
              />
            </div>
          )}

          {/* Stats Badges */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: '#eff6ff',
              border: '1px solid #bfdbfe',
              color: '#1d4ed8',
              padding: '5px 12px',
              borderRadius: 8,
              fontSize: 12.5,
              fontWeight: 700
            }}>
              <RouteIcon size={14} />
              <span>
                {selectedCourierId !== 'all'
                  ? `Yurilgan masofa: ${Number(routeData?.total_km ?? selectedCourier?.today_km ?? 0).toFixed(1)} km`
                  : `Jami yurilgan: ${totalKmToday.toFixed(1)} km`}
              </span>
            </div>

            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: '#fef3c7',
              border: '1px solid #fde68a',
              color: '#92400e',
              padding: '5px 12px',
              borderRadius: 8,
              fontSize: 12.5,
              fontWeight: 700
            }}>
              <Truck size={14} />
              <span>
                {selectedCourierId !== 'all'
                  ? `Faol yetkazish: ${selectedCourier?.active_deliveries_count || 0} ta`
                  : `Jami faol: ${totalActiveOrders} ta`}
              </span>
            </div>
          </div>
        </div>

        {/* Map Container */}
        <div style={{ flex: 1, position: 'relative', width: '100%', height: '100%', minHeight: 400 }}>
          <div
            ref={mapContainerRef}
            style={{ width: '100%', height: '100%', zIndex: 1 }}
          />

          {/* Loading overlay for route */}
          {routeLoading && (
            <div style={{
              position: 'absolute',
              top: 14,
              left: 50,
              zIndex: 1000,
              background: 'rgba(255,255,255,0.92)',
              padding: '6px 14px',
              borderRadius: 20,
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              fontSize: 12,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              color: '#0284c7'
            }}>
              <RefreshCw size={13} className="animate-spin" />
              Marshrut chizig‘i yuklanmoqda…
            </div>
          )}

          {/* Route Info Badge if showing polyline */}
          {routeData && (
            <div style={{
              position: 'absolute',
              bottom: 16,
              left: 16,
              zIndex: 1000,
              background: 'rgba(255, 255, 255, 0.95)',
              backdropFilter: 'blur(8px)',
              padding: '10px 14px',
              borderRadius: 12,
              border: '1px solid #e2e8f0',
              boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
              fontSize: 12.5,
              display: 'flex',
              flexDirection: 'column',
              gap: 4
            }}>
              <div style={{ fontWeight: 800, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#0284c7' }}></span>
                Yo‘l xaritasi (Marshrut)
              </div>
              <div style={{ color: '#475569' }}>
                Bosib o‘tilgan masofa: <b style={{ color: '#0284c7', fontSize: 13.5 }}>{routeData.total_km} km</b>
              </div>
              <div style={{ color: '#64748b', fontSize: 11 }}>
                Yozilgan GPS nuqtalari soni: <b>{routeData.points?.length || 0} ta</b>
              </div>
            </div>
          )}

          {/* Map Legend */}
          <div style={{
            position: 'absolute',
            bottom: 16,
            right: 16,
            zIndex: 1000,
            background: 'rgba(255, 255, 255, 0.92)',
            backdropFilter: 'blur(6px)',
            padding: '8px 12px',
            borderRadius: 10,
            border: '1px solid #e2e8f0',
            boxShadow: '0 2px 10px rgba(0,0,0,0.08)',
            fontSize: 11.5,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            color: '#334155'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#16a34a' }}></span>
              <b>Online</b> (oxirgi 10 daqiqada faol)
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#94a3b8' }}></span>
              <b>Offline</b>
            </div>
            {selectedCourierId !== 'all' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 14, height: 3, background: '#0284c7', borderRadius: 2 }}></span>
                <b>Marshrut yo‘li</b>
              </div>
            )}
          </div>
        </div>

        {/* Global CSS for Custom Leaflet Markers */}
        <style>{`
          .custom-courier-leaflet-marker {
            background: none !important;
            border: none !important;
          }
          .courier-map-marker {
            display: flex;
            flex-direction: column;
            align-items: center;
            cursor: pointer;
            transition: transform 0.2s ease;
          }
          .courier-map-marker:hover {
            transform: scale(1.08);
          }
          .courier-map-label {
            background: rgba(15, 23, 42, 0.9);
            backdrop-filter: blur(4px);
            color: #fff;
            padding: 3px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 700;
            white-space: nowrap;
            display: inline-flex;
            align-items: center;
            gap: 5px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.25);
            margin-bottom: 2px;
            border: 1px solid rgba(255,255,255,0.15);
          }
          .courier-status-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            display: inline-block;
          }
          .courier-status-dot.online {
            background: #22c55e;
            box-shadow: 0 0 8px #22c55e;
          }
          .courier-status-dot.offline {
            background: #94a3b8;
          }
          .courier-map-bubble {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: linear-gradient(135deg, #0284c7, #0369a1);
            border: 2px solid #ffffff;
            display: grid;
            place-items: center;
            box-shadow: 0 3px 10px rgba(2, 132, 199, 0.4);
            position: relative;
          }
          .courier-map-marker.online .courier-map-bubble {
            background: linear-gradient(135deg, #0284c7, #0369a1);
          }
          .courier-map-marker.offline .courier-map-bubble {
            background: linear-gradient(135deg, #64748b, #475569);
            box-shadow: 0 2px 6px rgba(0,0,0,0.2);
          }
          .bubble-icon {
            font-size: 15px;
            line-height: 1;
          }
        `}</style>
      </div>
    </div>
  );
}
