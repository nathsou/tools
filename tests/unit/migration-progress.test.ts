import {expect,test} from 'bun:test';
import {progressReporter} from '../../scripts/lib/progress';

test('terminal progress distinguishes discovery from measured completion and closes the line',()=>{
  let output='';const reporter=progressReporter({isTTY:true,write(text){output+=text;}});
  reporter.update({stage:'checking',scan:{phase:'discovering',path:'private filename',completed:0,total:3,bytesProcessed:0,bytesTotal:0,done:false}});
  expect(output).toContain('Discovering');expect(output).not.toContain('0%');
  reporter.update({stage:'checking',scan:{phase:'checking',path:'private filename',completed:3,total:3,bytesProcessed:10,bytesTotal:10,done:true}});
  reporter.finish();expect(output).toContain('100%');expect(output).toContain('\r\x1b[2K');expect(output.endsWith('\n')).toBe(true);expect(output).not.toContain('private filename');
});
