import ast,time
from pathlib import Path
r=Path(__file__).resolve().parents[1]
t=ast.parse((r/'backend/whoosh-input-proxy.py').read_text())
m=next(n for n in ast.walk(t) if isinstance(n,ast.FunctionDef) and n.name=='_maybe_emit_action')
ns={'DOMINANCE':1.25,'time':time};exec(compile(ast.Module(body=[m],type_ignores=[]),'proxy','exec'),ns)
class Proxy:
 base_centroid=(0,0);action_emitted=False;last_swipe_direction=None;last_swipe_motion=0.0
 configuration=type('Config',(),{'action_mm':4.5})()
 def __init__(self):self.actions=[]
 def send_action(self,a):self.actions.append(a)
p=Proxy()
for point in [(5,0),(5,-5),(-1,-5),(-1,1)]:ns['_maybe_emit_action'](p,point)
assert p.actions==['scroll_begin','right','up','left','down'],p.actions
print('Proxy: one session, four direction changes without release passed')

p=Proxy()
for x in range(5,55,5):ns['_maybe_emit_action'](p,(x,0))
assert p.actions==['scroll_begin','right'],p.actions
p.last_swipe_motion-=.2
ns['_maybe_emit_action'](p,(55,0))
assert p.actions==['scroll_begin','right','right'],p.actions
ns['_maybe_emit_action'](p,(50,0))
assert p.actions[-1]=='left'
print('Long strokes emit once; pauses rearm; reversals respond immediately')
