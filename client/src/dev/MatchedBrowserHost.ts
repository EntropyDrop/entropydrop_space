if (!import.meta.env.DEV || location.hostname !== 'localhost') throw Error('Local DEV only');
(window as any).matchedTrial=new URL(location.href).searchParams.get('trial');
const frame = document.querySelector<HTMLIFrameElement>('#fixture')!;
const status = document.querySelector('#status')!, button = document.querySelector<HTMLButtonElement>('#run')!;
const save = async (name: string, bytes: BodyInit) => {
  const response = await fetch(`http://127.0.0.1:54380/${name}`, {method:'POST',body:bytes});
  if (!response.ok) throw Error(`Capture failed: ${response.status}`);
};
(window as any).matchedHost = {
  async status(value: any) {status.textContent = JSON.stringify(value); await save('status.json', JSON.stringify(value));},
  async save(name: string, value: any) {
    if (name.endsWith('.png')) await save(name, Uint8Array.from(atob(value.split(',')[1]), c=>c.charCodeAt(0)));
    else await save(name, JSON.stringify(value));
  },
};
button.onclick = () => {
  button.disabled=true;
  frame.onload=()=>{
    const script=frame.contentDocument!.createElement('script');script.type='module';
    script.src=new URL('../src/dev/MatchedBrowserChild.ts',location.href).href;frame.contentDocument!.body.append(script);
  };
  frame.src='/space/app/?world=matched-blocks&dev_offline=1&dev_lod=world&dev_dpr=1&dev_msaa=0';
};
if(new URL(location.href).searchParams.get('autorun')==='1')button.click();
