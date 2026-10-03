/** Keep private view details in memory; browser history stores only random identifiers. */
export class ViewHistory<T> {
  private entries:{key:string;view:T}[]=[];
  private index=-1;
  private traversing=false;
  private returning:string|undefined;
  private readonly pop=(event:PopStateEvent)=>{
    if(this.returning===event.state?.crypteView){this.returning=undefined;this.traversing=false;return;}
    const next=this.entries.findIndex(entry=>entry.key===event.state?.crypteView),view=this.entries[next]?.view;
    if(this.guard&&!this.guard(view)){
      this.returning=this.entries[this.index]?.key;this.traversing=true;
      history.go(next>=0?this.index-next:1);return;
    }
    this.returning=undefined;
    this.traversing=false;
    this.index=next;
    this.restore(this.entries[this.index]?.view);
  };
  constructor(initial:T,private readonly restore:(view:T|undefined)=>void,private readonly guard?:(view:T|undefined)=>boolean) {
    this.reset(initial);
    window.addEventListener('popstate',this.pop);
  }
  reset(view:T):void {
    const entry={key:crypto.randomUUID(),view};
    this.entries=[entry];this.index=0;this.traversing=false;this.returning=undefined;
    history.replaceState({crypteView:entry.key},'');
  }
  update(view:T):void {
    const entry=this.entries[this.index];
    if(entry)entry.view=view;else this.reset(view);
  }
  push(view:T):void {
    const entry={key:crypto.randomUUID(),view};
    history.pushState({crypteView:entry.key},'');
    this.entries=this.entries.slice(0,this.index+1);
    this.entries.push(entry);this.index=this.entries.length-1;
  }
  rewrite(update:(view:T)=>T):void {for(const entry of this.entries)entry.view=update(entry.view);}
  backIf(matches:(view:T)=>boolean):boolean {
    if(this.traversing)return true;
    const previous=this.entries[this.index-1];
    if(!previous || !matches(previous.view))return false;
    this.traversing=true;history.back();return true;
  }
  destroy():void {
    window.removeEventListener('popstate',this.pop);
    this.entries=[];
  }
}
