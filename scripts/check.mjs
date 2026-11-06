import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const directories=['src','public','scripts','test'];let count=0;
for(const directory of directories)for(const file of fs.readdirSync(directory)){if(!/\.(js|mjs)$/.test(file))continue;execFileSync(process.execPath,['--check',path.join(directory,file)],{stdio:'inherit'});count++;}
console.log(`Syntax checks passed: ${count} files`);
