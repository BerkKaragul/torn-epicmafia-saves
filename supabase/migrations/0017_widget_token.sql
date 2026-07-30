-- Shared secret the Torn userscript widget uses to read live saver state
-- cross-site (the login cookie can't ride a torn.com → ChainWatch request).
-- Non-sensitive data only (saver names + chain timer), gated by this token.

alter table settings
  add column widget_token text not null default replace(gen_random_uuid()::text, '-', '');
