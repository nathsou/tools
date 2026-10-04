<script lang="ts">
  let {url,name,onerror}:{url:string;name:string;onerror:()=>void}=$props();
  let zoom=$state(1),x=$state(0),y=$state(0),stage=$state<HTMLDivElement>();
  let dragging=$state(false);
  const pointers=new Map<number,{x:number;y:number}>();
  let lastDistance=0;
  function reset(){zoom=1;x=y=0;}
  function scale(next:number,px=0,py=0){next=Math.min(8,Math.max(1,next));const ratio=next/zoom;x=px-(px-x)*ratio;y=py-(py-y)*ratio;zoom=next;if(zoom===1)x=y=0;bound();}
  function bound(){if(!stage)return;const width=stage.clientWidth*(zoom-1)/2,height=stage.clientHeight*(zoom-1)/2;x=Math.max(-width,Math.min(width,x));y=Math.max(-height,Math.min(height,y));}
  function wheel(event:WheelEvent){event.preventDefault();const rect=stage!.getBoundingClientRect();scale(zoom*Math.exp(-event.deltaY*.002),event.clientX-rect.left-rect.width/2,event.clientY-rect.top-rect.height/2);}
  function down(event:PointerEvent){if(event.button!==0)return;stage!.setPointerCapture(event.pointerId);pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});dragging=true;lastDistance=pointers.size===2?distance():0;}
  function distance(){const [a,b]=[...pointers.values()];return Math.hypot(a.x-b.x,a.y-b.y);}
  function move(event:PointerEvent){const previous=pointers.get(event.pointerId);if(!previous)return;pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});if(pointers.size===2){const next=distance(),[a,b]=[...pointers.values()],rect=stage!.getBoundingClientRect();if(lastDistance)scale(zoom*next/lastDistance,(a.x+b.x)/2-rect.left-rect.width/2,(a.y+b.y)/2-rect.top-rect.height/2);lastDistance=next;}else if(zoom>1){x+=event.clientX-previous.x;y+=event.clientY-previous.y;bound();}}
  function up(event:PointerEvent){pointers.delete(event.pointerId);lastDistance=0;dragging=pointers.size>0;}
</script>
<div class="image-controls"><button class="small-button" aria-label="Zoom out" disabled={zoom<=1} onclick={()=>scale(zoom/1.25)}>−</button><span aria-live="polite">{Math.round(zoom*100)}%</span><button class="small-button" aria-label="Zoom in" disabled={zoom>=8} onclick={()=>scale(zoom*1.25)}>+</button><button class="small-button" onclick={reset}>Fit image</button></div>
<div class="image-view" class:zoomed={zoom>1} class:dragging bind:this={stage} role="img" aria-label={`${name}. Scroll to zoom; drag to pan.`} onwheel={wheel} onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onlostpointercapture={up}>
  <img src={url} alt={name} draggable="false" style:transform={`translate(${x}px, ${y}px) scale(${zoom})`} {onerror}/>
</div>
