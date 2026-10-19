import { supabase } from './client.js';
/** A socket alone is not proof that the source transaction emits NOTIFY. */
export async function privateRecordTransportReady(): Promise<boolean> {
  const { data, error } = await supabase.rpc('fn_private_record_transport_ready');
  if (error) throw error;
  return data === true;
}
