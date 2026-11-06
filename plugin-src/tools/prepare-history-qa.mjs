import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
if(!process.argv[2])throw new Error('Provide the isolated QA manifest');
const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),vault=path.resolve(m.vault),file='history-fixture.md';
if(!vault.endsWith(path.join('app-qa','vault'))||!fs.existsSync(path.join(vault,'.git')))throw new Error('Refuse non-QA repository');
const git=(...args)=>execFileSync('git',['-C',vault,...args],{encoding:'utf8',windowsHide:true}).trim();
const body=Array.from({length:60},(_,i)=>`## Section ${i+1}\n\nParagraph ${i+1}: repeatable scrolling and rendering test content.\n`).join('\n');
const versions=['old','updated','latest'].map((label,index)=>`# History fixture\n\nVisible ${label} text with a [reference][target].\n\n| Key | Value |\n| --- | --- |\n| One | ${label} |\n${index===2?'| Two | Added row |\n':''}\n${body}\n[target]: /${label}\n`);
const commits=[];
for(let i=0;i<versions.length;i++){fs.writeFileSync(path.join(vault,file),versions[i]);git('add','--',file);if(git('diff','--cached','--name-only','--',file))git('-c','user.name=Plugin QA','-c','user.email=qa@localhost','commit','-m',`QA history version ${i+1}`,'--',file);commits.push(git('rev-parse','HEAD'));}
const result={file,commits,versions};fs.writeFileSync(path.join(m.output,'history-fixture.local.json'),JSON.stringify(result,null,2));console.log({file,commits});
