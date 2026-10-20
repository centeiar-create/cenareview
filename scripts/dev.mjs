import {spawn} from 'node:child_process';
// Accept the standard flags used by the local preview supervisor.
const args=process.argv.slice(2).filter(x=>x!=='--strictPort').map(x=>x==='--host'?'--ip':x);
const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev',...args],{stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code??1));
