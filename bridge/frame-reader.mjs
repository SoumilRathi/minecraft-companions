// Allocate each incoming frame once, even when a large history arrives in
// thousands of small socket chunks. Repeated Buffer.concat is quadratic here.
export class FrameReader {
  constructor(receive, maxBytes = 64 * 1024 * 1024) {
    this.receive=receive; this.maxBytes=maxBytes;
    this.header=Buffer.alloc(4); this.headerAt=0; this.body=null; this.bodyAt=0;
  }
  read(data) {
    let offset=0;
    while(offset<data.length) {
      if(this.body===null) {
        const n=Math.min(4-this.headerAt,data.length-offset);
        data.copy(this.header,this.headerAt,offset,offset+n); this.headerAt+=n; offset+=n;
        if(this.headerAt<4)continue;
        const size=this.header.readUInt32LE();
        if(!size||size>this.maxBytes)throw Error('Unsupported desktop frame size');
        this.body=Buffer.allocUnsafe(size);this.bodyAt=0;this.headerAt=0;
      }
      const n=Math.min(this.body.length-this.bodyAt,data.length-offset);
      data.copy(this.body,this.bodyAt,offset,offset+n);this.bodyAt+=n;offset+=n;
      if(this.bodyAt===this.body.length) {
        const body=this.body;this.body=null;this.bodyAt=0;
        this.receive(JSON.parse(body.toString('utf8')));
      }
    }
  }
}
