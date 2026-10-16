import {randomUUID} from 'node:crypto';

// A versioned notification: subscribe before waiting, and never miss a change
// that happened between a response and the next request. Epoch changes on restart.
export class Changes {
  constructor() {this.epoch=randomUUID();this.sequence=0;this.listeners=new Set();}
  get revision() {return `${this.epoch}:${this.sequence}`;}
  notify() {this.sequence++;for(const listener of [...this.listeners])listener();}
  wait(after,{signal,timeoutMs=20000}={}) {
    if(after!==this.revision||signal?.aborted)return Promise.resolve(this.revision);
    return new Promise(resolve=>{
      let timer;
      const finish=()=>{clearTimeout(timer);this.listeners.delete(finish);signal?.removeEventListener('abort',finish);resolve(this.revision);};
      this.listeners.add(finish);signal?.addEventListener('abort',finish,{once:true});
      timer=setTimeout(finish,timeoutMs);timer.unref?.();
    });
  }
}
