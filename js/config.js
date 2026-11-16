/* Supabase の設定(複数の端末でデータを共有するときだけ使う)。
   ・anon(publishable)キーは公開されても構いません(データは Row Level Security で守られます)。
   ・service_role / secret キーは絶対に入れないでください。
   ・空のままなら、端末内だけで動き、通信は一切しません。 */
window.TSUTSUKI_CONFIG = {
  supabaseUrl: 'https://qhcfjvzotvpeuxqkmktx.supabase.co',
  supabaseKey: 'sb_publishable_hvUApDVoL2GliRzQzVbtwQ_Hb4G-jdb'
};
