from pathlib import Path
import importlib.util,unittest
s=importlib.util.spec_from_file_location('tabs',str(Path(__file__).resolve().parents[1] / 'extension' / 'tab-target.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_content_is_noop(self):self.assertEqual(m.no_tab_outcome({'allowWindowClose':False}),'ignored')
 def test_titlebar_can_close(self):self.assertEqual(m.no_tab_outcome({'allowWindowClose':True}),'window')
 def test_unknown_legacy_cannot_close(self):self.assertEqual(m.no_tab_outcome([1,'window',100,300]),'closed')
 def legacy(self,x,y):return m.no_tab_outcome({'x':x,'y':y,'bounds':[{'x':90,'y':90,'width':620,'height':420},{'x':100,'y':100,'width':600,'height':400}]})
 def test_running_extension_content(self):self.assertEqual(self.legacy(300,300),'closed')
 def test_running_extension_titlebar(self):self.assertEqual(self.legacy(300,120),'window')
 def test_titlebar_bottom_boundary(self):self.assertEqual(self.legacy(300,156),'closed')
 def test_shadow_not_titlebar(self):self.assertEqual(self.legacy(95,120),'closed')
 def test_below_window(self):self.assertEqual(self.legacy(300,500),'closed')
if __name__ == '__main__':
 unittest.main()
