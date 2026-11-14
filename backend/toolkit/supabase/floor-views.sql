-- floor-views.sql (14 Nov 2026): choose each person's floor plan screen on the Staff logins page.
-- One optional Coloured Belts permission per person: floor_admin, floor_sarah, floor_master or floor_signin.
-- None = picked from their other ticks (admin/days -> Admin, results only -> Master, otherwise Sarah).
-- It only picks the screen; what they can change is still checked by their other permissions.
alter table public.app_permissions drop constraint if exists app_permissions_perm;
alter table public.app_permissions add constraint app_permissions_perm check (
  (app = 'cb' and perm in ('view','days','belts','readiness','results','calls','payments',
    'text_invite','text_result','text_followup','set_general','set_fees','set_wording','admin','texts','settings',
    'floor_admin','floor_sarah','floor_master','floor_signin')) or
  (app = 'bb' and perm in ('view','attendance','readiness','essays','days','grading','results','scoring','calls','payments',
    'text_invite','text_result','text_followup','certificates','idcards','polos','set_general','set_fees','set_wording','admin','texts','settings')) or
  (app = 'awards' and perm in ('view','edit','admin')));
