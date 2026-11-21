-- floor-bbc.sql (21 Nov 2026): the floor plan's student profile can invite a student to Black Belt Club (cb_bbc_invite),
-- so cb_floor_load returns whether they've already been asked for (bbc_invited_at, bbc_written_at).
do $$ declare d text; begin
  d := pg_get_functiondef('public.cb_floor_load(uuid)'::regprocedure);
  if position('bbc_invited_at' in d) = 0 then
    d := replace(d, '''bbc'', (m.bbc_seen_at', '''bbc_invited_at'', m.bbc_invited_at, ''bbc_written_at'', m.bbc_written_at, ''bbc'', (m.bbc_seen_at');
    execute d;
  end if;
end $$;
