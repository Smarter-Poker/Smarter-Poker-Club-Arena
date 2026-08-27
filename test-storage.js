import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://kuklfnapbkmacvwxktbh.supabase.co'
const supabaseKey = 'sb_secret_-JMU3PyMvxxkGYzKLTzrbQ_OZPZQuYW' 

try {
  const supabase = createClient(supabaseUrl, supabaseKey)
  const { data, error } = await supabase.storage.listBuckets()
  console.log('Error:', error)
  console.log('Buckets:', data?.map(b => b.name))
} catch (e) {
  console.error(e)
}
