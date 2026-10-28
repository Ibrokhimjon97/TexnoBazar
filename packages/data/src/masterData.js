import { getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';

const masterTables = {
  branches: ['code','name','phone','address','timezone','currency','is_active'],
  locations: ['branch_id','code','name','type','is_active'],
  categories: ['parent_id','name','slug','description','seo_title','seo_description','seo_image_url','sort_order','is_active'],
  brands: ['name','slug','description','logo_url','is_active'],
  attribute_definitions: ['category_id','code','name','data_type','options','is_required','is_filterable','sort_order'],
  suppliers: ['code','name','contact_name','phone','email','address','is_active'],
  payment_methods: ['code','name','is_cash','is_online','is_active','sort_order'],
};
const projections = {
  branches: 'id,code,name,phone,address,timezone,currency,is_active,created_at,updated_at',
  locations: 'id,branch_id,code,name,type,is_active,created_at,updated_at',
  categories: 'id,parent_id,name,slug,description,seo_title,seo_description,seo_image_url,sort_order,is_active,created_at,updated_at',
  brands: 'id,name,slug,description,logo_url,is_active,created_at,updated_at',
  attribute_definitions: 'id,category_id,code,name,data_type,options,is_required,is_filterable,sort_order,created_at,updated_at',
  suppliers: 'id,code,name,contact_name,phone,email,address,balance,is_active,created_at,updated_at',
  payment_methods: 'id,code,name,is_cash,is_online,is_active,sort_order,created_at,updated_at',
};
function tableConfig(table) {
  if (!masterTables[table]) throw new Error('Noma’lum ma’lumotnoma turi.');
  return masterTables[table];
}
function cleanPayload(table, input) {
  const allowed = tableConfig(table);
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => allowed.includes(key) && value !== undefined));
}
export async function listMasterRecords(table) {
  tableConfig(table);
  const orderField = ['categories','attribute_definitions','payment_methods'].includes(table) ? 'sort_order' : 'created_at';
  const ascending = orderField === 'sort_order';
  const { data, error } = await getBrowserClient().from(table).select(projections[table]).order(orderField, { ascending }).order('name', { ascending: true });
  if (error) throwDataError(error, `list:${table}`);
  return data ?? [];
}
export async function createMasterRecord(table, input) {
  const { data, error } = await getBrowserClient().from(table).insert(cleanPayload(table, input)).select(projections[table]).single();
  if (error) throw error;
  return data;
}
export async function updateMasterRecord(table, id, input) {
  tableConfig(table);
  const { data, error } = await getBrowserClient().from(table).update(cleanPayload(table, input)).eq('id', id).select(projections[table]).single();
  if (error) throw error;
  return data;
}
export async function setMasterRecordActive(table, id, isActive) {
  if (!masterTables[table]?.includes('is_active')) throw new Error('Bu ma’lumotnomada holat boshqarilmaydi.');
  return updateMasterRecord(table, id, { is_active: isActive });
}
export async function deleteMasterRecord(table, id) {
  tableConfig(table);
  if (table === 'branches') {
    const { error } = await getBrowserClient().rpc('delete_branch', { p_branch_id: id });
    if (error) throw error;
    return;
  }
  if (table === 'locations') {
    const { error } = await getBrowserClient().rpc('delete_location', { p_location_id: id });
    if (error) throw error;
    return;
  }
  const { error } = await getBrowserClient().from(table).delete().eq('id', id);
  if (error) throw error;
}
