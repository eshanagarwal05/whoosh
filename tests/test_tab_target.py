from pathlib import Path
import importlib.util,unittest
from types import SimpleNamespace as NS
spec=importlib.util.spec_from_file_location('tabs',str(Path(__file__).resolve().parents[1] / 'extension' / 'tab-target.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
R=NS(PAGE_TAB=1,DOCUMENT_WEB=2,DOCUMENT_FRAME=3,PUSH_BUTTON=4,FRAME=5,WINDOW=6,DIALOG=7,GROUPING=8,PANEL=9)
S=NS(SHOWING=1,ACTIVE=2,SELECTED=3)
api=NS(Role=R,StateType=S,CoordType=NS(WINDOW=1))
class Node:
 def __init__(self,role=9,name='',bounds=(0,0,600,400),kids=(),attrs=None,states=None,actions=(),pid=1):
  self.role=role;self.name=name;self.bounds=bounds;self.kids=list(kids);self.attrs=attrs or {};self.states=set([1] if states is None else states);self.actions=actions;self.parent=None;self.calls=[];self.pid=pid
  for c in self.kids:c.parent=self
 def get_role(self):return self.role
 def get_name(self):return self.name
 def get_attributes(self):return self.attrs
 def get_child_count(self):return len(self.kids)
 def get_child_at_index(self,i):return self.kids[i]
 def get_parent(self):return self.parent
 def get_index_in_parent(self):return self.parent.kids.index(self)
 def get_state_set(self):return NS(contains=lambda k:k in self.states)
 def get_component_iface(self):return self
 def get_extents(self,_):return NS(x=self.bounds[0],y=self.bounds[1],width=self.bounds[2],height=self.bounds[3])
 def get_action_iface(self):return self if self.actions else None
 def get_n_actions(self):return len(self.actions)
 def get_action_name(self,i):return self.actions[i]
 def do_action(self,i):self.calls.append(i);self.states.add(3);return True
 def get_selection_iface(self):return None
 def clear_cache(self):pass
 def get_process_id(self):return self.pid
class Tests(unittest.TestCase):
 def test_inactive_tab(self):
  a=Node(1,bounds=(0,0,100,30));b=Node(1,bounds=(100,0,100,30));self.assertIs(m.find_tab(Node(kids=[a,b]),150,15,api),b)
 def test_below_toolbar(self):
  a=Node(1,bounds=(100,100,100,30));self.assertIs(m.find_tab(Node(kids=[a]),150,110,api),a)
 def test_vertical_tab(self):
  a=Node(1,bounds=(0,260,100,40));self.assertIs(m.find_tab(Node(kids=[a]),50,280,api),a)
 def test_blank_region(self):self.assertIsNone(m.find_tab(Node(kids=[Node(1,bounds=(0,0,100,30))]),150,15,api))
 def test_web_tabs_excluded(self):self.assertIsNone(m.find_tab(Node(2,kids=[Node(1)]),10,10,api))
 def test_electron_tabs_in_document(self):
  a=Node(1,bounds=(200,200,100,50));self.assertIs(m.find_tab(Node(2,bounds=(0,0,1200,800),kids=[a]),120,110,api,True,'electron',2),a)
 def test_hidden_tab(self):self.assertIsNone(m.find_tab(Node(1,states=[]),10,10,api))
 def test_direct_close(self):
  a=Node(1,actions=['activate','close']);self.assertTrue(m.close_tab(a,api));self.assertEqual(a.calls,[1])
 def test_child_close(self):
  b=Node(4,'Close Tab',actions=['click']);self.assertTrue(m.close_tab(Node(1,kids=[b]),api));self.assertEqual(b.calls,[0])
 def test_grouped_close(self):
  a=Node(1);b=Node(4,'Close Tab',actions=['click']);Node(R.GROUPING,kids=[a,b]);self.assertTrue(m.close_tab(a,api))
 def test_no_shared_group_close(self):
  a=Node(1);b=Node(4,'Close',actions=['click']);Node(R.GROUPING,kids=[a,Node(1),b]);self.assertFalse(m.close_tab(a,api));self.assertEqual(b.calls,[])
 def test_selection_verified(self):
  a=Node(1,actions=['activate']);self.assertTrue(m.select_tab(a,api));self.assertEqual(a.calls,[0])
 def test_unselectable(self):self.assertFalse(m.select_tab(Node(1),api))
 def test_obsidian_header(self):self.assertTrue(m.is_tab(Node(attrs={'class':'workspace-tab-header tappable'}),api,'obsidian'))
 def test_obsidian_sidebar_ignored(self):
  a=Node(attrs={'class':'workspace-tab-header'});Node(attrs={'class':'workspace-split mod-sidedock'},kids=[a]);self.assertFalse(m.is_tab(a,api,'obsidian'))
 def test_custom_class_not_global(self):self.assertFalse(m.is_tab(Node(attrs={'class':'workspace-tab-header'}),api,'other'))
 def test_profile_suffix(self):
  a=Node(5,'New Tab - Google Chrome - Work');self.assertIs(m.choose_window([a],'New Tab - Google Chrome',api),a)
 def test_exact_title_preferred(self):
  a=Node(5,'New Tab');b=Node(5,'New Tab - Work');self.assertIs(m.choose_window([a,b],'New Tab',api),a)
 def test_identical_profiles_active(self):
  a=Node(5,'New Tab - Work');b=Node(5,'New Tab - Work',states=[1,2]);self.assertIs(m.choose_window([a,b],'New Tab',api,require_active=True),b)
 def test_ambiguous_refused(self):
  with self.assertRaises(RuntimeError):m.choose_window([Node(5,'New Tab'),Node(5,'New Tab')],'New Tab',api)
 def test_geometry_disambiguates(self):
  a=Node(5,'New Tab',bounds=(0,0,500,400));b=Node(5,'New Tab');self.assertIs(m.choose_window([a,b],'New Tab',api,[{'width':600,'height':400}]),b)
 def test_popup_not_selected(self):
  a=Node(5,'New Tab');self.assertIs(m.choose_window([a,Node(5,'',bounds=(0,0,50,20))],'New Tab',api),a)
if __name__ == '__main__':
 unittest.main()
