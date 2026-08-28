// prmpt -- the script injected into Cursor's renderer.
//
// This is a string because it does not run here. It is written into Cursor's
// own workbench.js and executes in the renderer, so it gets no bundler, no
// imports and no Node. Plain ES5-ish DOM code on purpose.
//
// What it does: find the chat composer, and while the agent is generating,
// insert one card directly above the input showing the ad the hook parked for
// the previous turn. That moment -- the wait -- is the whole placement.
//
// Everything is defensive. A throw in here happens inside Cursor's own startup
// path, so every entry point is wrapped and the failure mode is "no card",
// never "no editor".

/** Must match DEFAULT_PORT / PORT_SPAN in bridge.ts. */
const PORT_BASE = 51793;
const PORT_SPAN = 5;

export function chatInjectScript(portBase: number = PORT_BASE): string {
  return `(function(){
try{
  if(window.__PRMPT__)return; window.__PRMPT__=1;
  var PORTS=[]; for(var i=0;i<${PORT_SPAN};i++)PORTS.push(${portBase}+i);
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
})();`;
}
