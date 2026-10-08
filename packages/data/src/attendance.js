import { getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';

async function rpc(name, args = {}) {
  const { data, error } = await getBrowserClient().rpc(name, args);
  if (error) throwDataError(error, name);
  return data;
}

/**
 * Browser GPS geolocation-ni olish uchun xavfsiz yordamchi funksiya.
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<{lat: number|null, lng: number|null, accuracy: number|null, error: string|null}>}
 */
export async function getBrowserLocation(timeoutMs = 10000) {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return { lat: null, lng: null, accuracy: null, error: 'Qurilmada geolokatsiya qo‘llab-quvvatlanmaydi' };
  }
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => {
        resolve({
          lat: Number(pos.coords.latitude.toFixed(7)),
          lng: Number(pos.coords.longitude.toFixed(7)),
          accuracy: Math.round(pos.coords.accuracy || 0),
          error: null,
        });
      },
      err => {
        let msg = 'Lokatsiyani aniqlab bo‘lmadi';
        if (err.code === 1) msg = 'Geolokatsiyaga ruxsat berilmadi';
        else if (err.code === 2) msg = 'GPS signali topilmadi';
        else if (err.code === 3) msg = 'Lokatsiyani aniqlash vaqti tugadi';
        resolve({ lat: null, lng: null, accuracy: null, error: msg });
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 }
    );
  });
}

/**
 * Ishga kelishni qayd etish (Clock In)
 */
export function clockIn({ branchId = null, lat = null, lng = null, accuracy = null, address = null } = {}) {
  return rpc('clock_in', {
    p_branch_id: branchId,
    p_lat: lat,
    p_lng: lng,
    p_accuracy: accuracy,
    p_address: address,
  });
}

/**
 * Ishni yakunlashni qayd etish (Clock Out)
 */
export function clockOut({ lat = null, lng = null, accuracy = null, address = null } = {}) {
  return rpc('clock_out', {
    p_lat: lat,
    p_lng: lng,
    p_accuracy: accuracy,
    p_address: address,
  });
}

/**
 * Foydalanuvchining bugungi davomat yozuvi
 */
export function getMyTodayAttendance() {
  return rpc('get_my_today_attendance');
}

/**
 * Foydalanuvchining o'z davomat tarixi
 */
export function getMyAttendanceHistory({ from = null, to = null } = {}) {
  return rpc('get_my_attendance_history', {
    p_from: from,
    p_to: to,
  });
}

/**
 * Menejer va Admin uchun xodimlar davomati ro'yxati
 */
export function getAttendanceList({ branchId = null, employeeId = null, from = null, to = null, search = null } = {}) {
  return rpc('get_attendance_list', {
    p_branch_id: branchId || null,
    p_employee_id: employeeId || null,
    p_from: from || null,
    p_to: to || null,
    p_search: search || null,
  });
}

/**
 * Filial xodimlari ro'yxati (Menejer va Admin uchun)
 */
export function listBranchEmployees(branchId = null) {
  return rpc('list_branch_employees', {
    p_branch_id: branchId || null,
  });
}

/**
 * Google Maps link yasash
 */
export function getGoogleMapsUrl(lat, lng) {
  if (lat == null || lng == null) return null;
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

/**
 * Ishlangan daqiqalarni chiroyli formatlash
 */
export function formatWorkedDuration(minutes) {
  if (minutes == null || isNaN(minutes) || minutes < 0) return '—';
  const m = Math.round(minutes);
  const hours = Math.floor(m / 60);
  const mins = m % 60;
  if (hours === 0) return `${mins} daqiqa`;
  if (mins === 0) return `${hours} soat`;
  return `${hours} soat ${mins} daqiqa`;
}

export {
  UZ_MONTHS,
  UZ_MONTHS_LOWER,
  UZ_WEEKDAYS_LONG,
  UZ_WEEKDAYS_SHORT,
  formatUzDate,
  getUzWeekday,
  getUzMonthName,
  formatUzTime,
} from './date.js';
