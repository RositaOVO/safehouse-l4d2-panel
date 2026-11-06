import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const directories=['src','public','scripts','test'];let count=0;
function visit(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())visit(file);else if(/\.(js|mjs)$/.test(entry.name)){execFileSync(process.execPath,['--check',file],{stdio:'inherit'});count++;}}}
for(const directory of directories)visit(directory);
console.log(`Syntax checks passed: ${count} files`);
