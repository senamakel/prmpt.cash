"use strict";var G=Object.create;var x=Object.defineProperty;var X=Object.getOwnPropertyDescriptor;var Q=Object.getOwnPropertyNames;var Z=Object.getPrototypeOf,ee=Object.prototype.hasOwnProperty;var te=(t,e)=>{for(var n in e)x(t,n,{get:e[n],enumerable:!0})},A=(t,e,n,o)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of Q(e))!ee.call(t,r)&&r!==n&&x(t,r,{get:()=>e[r],enumerable:!(o=X(e,r))||o.enumerable});return t};var l=(t,e,n)=>(n=t!=null?G(Z(t)):{},A(e||!t||!t.__esModule?x(n,"default",{value:t,enumerable:!0}):n,t)),ne=t=>A(x({},"__esModule",{value:!0}),t);var be={};te(be,{activate:()=>me,deactivate:()=>ge});module.exports=ne(be);var s=l(require("vscode"));var m=l(require("node:fs")),I=l(require("node:os")),S=l(require("node:path")),oe=1800*1e3;function _(){let t=process.env.XDG_CONFIG_HOME,e=t&&t.trim()?t:S.join(I.homedir(),".config");return S.join(e,"prmpt")}function re(){return S.join(_(),"slot.json")}function se(){let t=Number.parseInt(process.env.PRMPT_SLOT_TTL_MS??"",10);return Number.isFinite(t)&&t>0?t:oe}function p(t=Date.now()){let e;try{e=JSON.parse(m.readFileSync(re(),"utf8"))}catch{return null}if(!e||typeof e!="object")return null;let n=e,o=typeof n.headline=="string"?n.headline.trim():"",r=typeof n.clickUrl=="string"?n.clickUrl.trim():"";if(!o||!r||typeof n.ts!="number"||t-n.ts>se())return null;try{let d=new URL(r);if(d.protocol!=="https:"&&d.protocol!=="http:")return null}catch{return null}return{requestId:typeof n.requestId=="string"?n.requestId:"",headline:o,body:typeof n.body=="string"?n.body.trim():"",clickUrl:r,sessionId:typeof n.sessionId=="string"?n.sessionId:"",harness:typeof n.harness=="string"?n.harness:"",ts:n.ts}}function $(t){let e,n;(()=>{try{m.mkdirSync(_(),{recursive:!0,mode:448}),e=m.watch(_(),(d,c)=>{c&&!String(c).startsWith("slot.json")||(n&&clearTimeout(n),n=setTimeout(t,120))})}catch{}})();let r=setInterval(t,6e4);return()=>{n&&clearTimeout(n),clearInterval(r);try{e?.close()}catch{}}}var g=class{constructor(e){this.onOpen=e}static viewType="prmpt.adCard";view;resolveWebviewView(e){this.view=e,e.webview.options={enableScripts:!0,localResourceRoots:[]},e.webview.onDidReceiveMessage(n=>{if(n?.type==="open"){let o=p();o&&this.onOpen(o)}}),this.render()}render(){this.view&&(this.view.webview.html=ae(p()))}};function ie(){let t="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",e="";for(let n=0;n<32;n++)e+=t[Math.floor(Math.random()*t.length)];return e}function ae(t){let e=ie(),n=`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${e}';`;return t?`<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${n}">
<style>${N()}</style></head><body>
<div class="card" id="card" role="link" tabindex="0">
  <div class="label">Sponsored</div>
  <div class="headline" id="headline"></div>
  <div class="body" id="body"></div>
  <div class="open">Open \u2197</div>
</div>
<script nonce="${e}">
  const vscodeApi = acquireVsCodeApi();
  // textContent, never innerHTML: this copy is model-generated.
  document.getElementById('headline').textContent = ${JSON.stringify(t.headline)};
  document.getElementById('body').textContent = ${JSON.stringify(t.body)};
  const card = document.getElementById('card');
  const open = () => vscodeApi.postMessage({ type: 'open' });
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
</script>
</body></html>`:`<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${n}">
<style>${N()}</style></head><body>
<div class="empty">No sponsored line right now.<br><span class="hint">One appears after an agent turn that matches.</span></div>
</body></html>`}function N(){return`
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
           color: var(--vscode-foreground); padding: 8px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px;
            cursor: pointer; background: var(--vscode-editorWidget-background); }
    .card:hover { border-color: var(--vscode-focusBorder); }
    .card:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .label { font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
             opacity: .6; margin-bottom: 6px; }
    .headline { font-weight: 600; line-height: 1.35; }
    .body { opacity: .8; line-height: 1.4; margin-top: 4px; }
    .open { margin-top: 8px; font-size: 11px; color: var(--vscode-textLink-foreground); }
    .empty { opacity: .6; line-height: 1.5; }
    .hint { font-size: 11px; opacity: .8; }
  `}var f=l(require("vscode"));var ce=48,k=class{item;constructor(){this.item=f.window.createStatusBarItem(f.StatusBarAlignment.Left,-100),this.item.command="prmpt.openCurrentAd"}render(){let n=f.workspace.getConfiguration("prmpt").get("showStatusBar",!0)?p():null;if(!n){this.item.hide();return}this.item.text=`$(megaphone) ${de(n.headline,ce)}`,this.item.tooltip=pe(n),this.item.show()}dispose(){this.item.dispose()}};function de(t,e){let n=t.replace(/\s+/g," ").trim();return n.length<=e?n:`${n.slice(0,e-1).trimEnd()}\u2026`}function pe(t){let e=new f.MarkdownString;return e.appendMarkdown(`**Sponsored** \u2014 ${D(t.headline)}

`),t.body&&e.appendMarkdown(`${D(t.body)}

`),e.appendMarkdown("_Click to open. prmpt pays you 70% of the click price._"),e}function D(t){return t.replace(/([\\`*_{}\[\]()#+\-.!])/g,"\\$1")}var L=l(require("node:http"));var b=51793,le=5,P=class{constructor(e){this.onOpen=e}server;port=0;async start(e){let n=Number.isFinite(e)&&e>0?e:b;for(let o=0;o<le;o++){let r=n+o;try{return this.port=await this.listen(r),this.port}catch{}}return 0}listen(e){return new Promise((n,o)=>{let r=L.createServer((d,c)=>{if(d.method!=="GET"||!d.url){c.writeHead(404).end();return}if(d.url.startsWith("/open")){this.onOpen(),c.writeHead(204).end();return}if(!d.url.startsWith("/slot")){c.writeHead(404).end();return}let u=p();c.writeHead(200,{"content-type":"application/json","cache-control":"no-store","access-control-allow-origin":"*"}),c.end(JSON.stringify(u?{requestId:u.requestId,headline:u.headline,body:u.body}:null))});r.once("error",o),r.listen(e,"127.0.0.1",()=>n(e)),this.server=r})}dispose(){try{this.server?.close()}catch{}}};var i=l(require("node:fs")),V=l(require("node:path")),C=l(require("vscode"));function B(t=51793){return`(function(){
try{
  if(window.__PRMPT__)return; window.__PRMPT__=1;
  var PORTS=[]; for(var i=0;i<5;i++)PORTS.push(${t}+i);
  var AD=null, PORT=null;

  function fetchSlot(cb){
    var tried=0;
    function tryPort(idx){
      if(idx>=PORTS.length){if(cb)cb();return;}
      fetch('http://127.0.0.1:'+PORTS[idx]+'/slot',{cache:'no-store'})
        .then(function(r){if(!r.ok)throw 0;return r.json();})
        .then(function(d){PORT=PORTS[idx];AD=d;if(cb)cb();})
        .catch(function(){tryPort(idx+1);});
    }
    // Once a port answers, stay on it rather than re-probing every poll.
    if(PORT!==null){
      fetch('http://127.0.0.1:'+PORT+'/slot',{cache:'no-store'})
        .then(function(r){if(!r.ok)throw 0;return r.json();})
        .then(function(d){AD=d;if(cb)cb();})
        .catch(function(){PORT=null;tryPort(0);});
      return;
    }
    tryPort(tried);
  }

  // --- finding the composer -------------------------------------------------
  // Cursor renames its classes freely between versions, so match on structure
  // (an editable inside something composer-ish) rather than one exact class.
  var EDIT_SEL='textarea,[contenteditable="true"]';
  function composerInputs(){
    var out=[],nodes=document.querySelectorAll(EDIT_SEL);
    for(var i=0;i<nodes.length;i++){
      var n=nodes[i];
      if(n.closest('.composer-input-wrapper,.composer-input-container,[class*="composer"]'))out.push(n);
    }
    return out;
  }
  function inputBox(input){
    return input.closest('.composer-input-container')||
           input.closest('.full-input-box')||
           input.closest('.composer-input-wrapper')||
           input.parentElement;
  }

  // --- is the agent generating? --------------------------------------------
  // The Stop control is the most stable signal Cursor gives: it exists only
  // while a turn is in flight. Its label varies ("Stop", "Stop generation",
  // "Stop ^C"), so match the prefix.
  function generating(scope){
    if(!scope)return false;
    var els=scope.querySelectorAll('button,[role="button"],[aria-label]');
    for(var i=0;i<els.length;i++){
      var t=((els[i].getAttribute('aria-label')||els[i].textContent)||'').trim();
      if(/^stop\\b/i.test(t))return true;
    }
    return false;
  }

  // --- the card -------------------------------------------------------------
  function build(){
    var wrap=document.createElement('div');
    wrap.className='prmpt-chat-ad';
    wrap.style.cssText='width:100%;flex:0 0 100%;box-sizing:border-box;padding:0 0 6px 0;';
    var card=document.createElement('div');
    card.setAttribute('data-prmpt-card','1');
    card.style.cssText='border:1px solid rgba(127,127,127,.28);border-radius:6px;padding:8px 10px;'+
      'font-size:11px;line-height:1.4;cursor:pointer;opacity:.85;';
    var label=document.createElement('div');
    label.textContent='SPONSORED';
    label.style.cssText='font-size:9px;letter-spacing:.09em;opacity:.55;margin-bottom:3px;';
    var head=document.createElement('div');
    head.style.cssText='font-weight:600;';
    var body=document.createElement('div');
    body.style.cssText='opacity:.75;margin-top:2px;';
    card.appendChild(label);card.appendChild(head);card.appendChild(body);
    wrap.appendChild(card);
    card.addEventListener('click',function(){
      // Ask the extension host to open it. The renderer never opens a URL
      // itself: window.open inside Electron is unreliable and would bypass
      // vscode.env.openExternal, which is what the other surfaces use.
      if(PORT!==null)fetch('http://127.0.0.1:'+PORT+'/open',{cache:'no-store'}).catch(function(){});
    });
    wrap.__head=head;wrap.__body=body;
    return wrap;
  }

  function fill(node){
    if(!AD)return;
    // textContent, never innerHTML: this copy is model-generated.
    node.__head.textContent=AD.headline||'';
    node.__body.textContent=AD.body||'';
  }

  function place(node,input){
    var box=inputBox(input);
    if(!box||!box.parentElement)return;
    var par=box.parentElement;
    var dups=par.querySelectorAll('.prmpt-chat-ad');
    for(var i=0;i<dups.length;i++){
      if(dups[i]!==node&&dups[i].parentElement===par)dups[i].parentElement.removeChild(dups[i]);
    }
    if(node.parentElement!==par||node.nextElementSibling!==box)par.insertBefore(node,box);
  }

  function tick(){
    try{
      var inputs=composerInputs();
      for(var i=0;i<inputs.length;i++){
        var input=inputs[i];
        var scope=input.closest('[class*="composer"]')||input.parentElement;
        var node=input.__prmptNode;
        if(!node){node=build();input.__prmptNode=node;}
        if(!AD||!generating(scope)){if(node.isConnected)node.style.display='none';continue;}
        fill(node);place(node,input);node.style.display='block';
      }
    }catch(e){}
  }

  function boot(){
    fetchSlot();
    setInterval(function(){fetchSlot();},15000);
    setInterval(tick,400);
    tick();
  }
  function wait(){if(document.body)boot();else setTimeout(wait,100);}
  wait();
}catch(e){}
})();`}var F="/*__PRMPT_PATCH_V1__*/",h=/\/\*__PRMPT_PATCH_V\d+__\*\//,R='performance.mark("code/didLoadWorkbenchMain"),B.main(S)})();',ue='performance.mark("code/didLoadWorkbenchMain"),B.main(S),setTimeout(function(){typeof PRMPT_RUN==="function"&&PRMPT_RUN()},2500)})();';function j(t){return h.test(t)}function U(t){return h.test(t)&&!t.includes(F)}function E(t){let e=t,n=e.search(h);return n>=0&&(e=`${e.slice(0,n).trimEnd()}
`),e=e.replace(/performance\.mark\("code\/didLoadWorkbenchMain"\),B\.main\(S\),[^}]+\}\)\(\);/,R),e}function W(t){return t.includes(R)}function H(t,e){return`${t.replace(R,ue)}
${F}
function PRMPT_RUN(){${e}}
`}var O=".prmpt-backup",w="out/vs/code/electron-sandbox/workbench/workbench.js",fe=["out/vs/workbench/workbench.desktop.main.js","out/vs/workbench/workbench.glass.main.js"];function v(t){return V.join(C.env.appRoot,t)}function T(){return(C.env.appName||"").toLowerCase().includes("cursor")?!0:(C.env.appRoot||"").toLowerCase().includes("cursor")}function q(){try{return T()&&i.existsSync(v(w))}catch{return!1}}function M(){try{return j(i.readFileSync(v(w),"utf8"))}catch{return!1}}function K(){try{return U(i.readFileSync(v(w),"utf8"))}catch{return!1}}function z(){for(let t of fe){let e=v(t),n=e+O;try{if(i.existsSync(n)){i.copyFileSync(n,e),i.rmSync(n,{force:!0});continue}if(!i.existsSync(e))continue;let o=i.readFileSync(e,"utf8"),r=o.search(h);r>=0&&i.writeFileSync(e,`${o.slice(0,r).trimEnd()}
`)}catch{}}}function y(t){let e=v(w);if(!i.existsSync(e))return{ok:!1,message:"Cursor workbench.js not found \u2014 unsupported build."};try{z();let n=e+O;i.existsSync(n)||i.copyFileSync(e,n);let o=E(i.readFileSync(n,"utf8"));if(!W(o))return{ok:!1,message:"Cursor\u2019s startup code has changed and the patch no longer fits. The sidebar and status bar still work; the chat card does not."};let r=B(t);try{new Function(r)}catch{return{ok:!1,message:"Generated patch failed validation \u2014 Cursor untouched."}}return i.writeFileSync(e,H(o,r)),{ok:!0,message:"Chat card enabled. Reload Cursor to see it."}}catch(n){return{ok:!1,message:`Could not write to the Cursor install (${n instanceof Error?n.message:String(n)}). Nothing was changed.`}}}function J(){let t=v(w),e=t+O;try{if(z(),i.existsSync(e))return i.copyFileSync(e,t),i.rmSync(e,{force:!0}),{ok:!0,message:"Chat card removed. Reload Cursor."};if(!i.existsSync(t))return{ok:!0,message:"Nothing to remove."};let n=i.readFileSync(t,"utf8");return h.test(n)?(i.writeFileSync(t,E(n)),{ok:!0,message:"Chat card removed. Reload Cursor."}):{ok:!0,message:"Nothing to remove."}}catch(n){return{ok:!1,message:`Could not restore the Cursor install (${n instanceof Error?n.message:String(n)}).`}}}var Y="prmpt.chatCardDeclined";async function me(t){let e=a=>{s.env.openExternal(s.Uri.parse(a.clickUrl))},n=new g(e),o=new k,r=new P(()=>{let a=p();a&&e(a)}),d=()=>s.workspace.getConfiguration("prmpt"),c=d().get("bridgePort",b);await r.start(c);let u=()=>{n.render(),o.render()};t.subscriptions.push(s.window.registerWebviewViewProvider(g.viewType,n,{webviewOptions:{retainContextWhenHidden:!0}}),o,{dispose:$(u)},{dispose:()=>r.dispose()},s.workspace.onDidChangeConfiguration(a=>{a.affectsConfiguration("prmpt")&&u()})),t.subscriptions.push(s.commands.registerCommand("prmpt.openCurrentAd",()=>{let a=p();a?e(a):s.window.showInformationMessage("prmpt: no sponsored line is parked right now.")}),s.commands.registerCommand("prmpt.applyCursorPatch",async()=>{let a=y(d().get("bridgePort",b));await(a.ok?s.window.showInformationMessage(`prmpt: ${a.message}`):s.window.showWarningMessage(`prmpt: ${a.message}`))}),s.commands.registerCommand("prmpt.removeCursorPatch",async()=>{let a=J();await(a.ok?s.window.showInformationMessage(`prmpt: ${a.message}`):s.window.showWarningMessage(`prmpt: ${a.message}`))}),s.commands.registerCommand("prmpt.showStatus",()=>ve())),u(),he(t)}async function he(t){if(!q())return;let e=s.workspace.getConfiguration("prmpt").get("cursorChatCard","ask");if(e==="off")return;let n=s.workspace.getConfiguration("prmpt").get("bridgePort",b);if(K()){y(n);return}if(M())return;if(e==="on"){y(n);return}if(t.globalState.get(Y))return;let o="Enable";if(await s.window.showInformationMessage("prmpt can show the sponsored line above Cursor\u2019s chat input while the agent is working. Cursor has no extension point for that, so this modifies one file inside your Cursor installation (workbench.js). A backup is kept and \u201Cprmpt: Remove Cursor Chat Card\u201D restores it. The sidebar and status bar work either way.",o,"Not now")!==o){await t.globalState.update(Y,!0);return}let c=y(n);await(c.ok?s.window.showInformationMessage(`prmpt: ${c.message}`):s.window.showWarningMessage(`prmpt: ${c.message}`))}function ve(){let t=p(),e=[`host: ${s.env.appName}${T()?" (chat card supported)":""}`,`parked ad: ${t?t.headline:"(none)"}`];T()&&e.push(`chat card: ${M()?"enabled":"not enabled"}`),s.window.showInformationMessage(`prmpt \u2014 ${e.join(" \xB7 ")}`)}function ge(){}0&&(module.exports={activate,deactivate});
