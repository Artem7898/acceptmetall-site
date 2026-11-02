import net from 'node:net';

// ClamAV INSTREAM: scan bytes over a private local network; never execute filenames.
export function scanWithClamd(buffer,{host='127.0.0.1',port=3310,timeout=10000}={}) {
  return new Promise((resolve,reject)=> {
    const socket=net.createConnection({host,port});
    let answer='';
    const end=error=>{socket.destroy();error?reject(error):resolve();};
    socket.setTimeout(timeout,()=>end(new Error('scanner_timeout')));
    socket.on('error',()=>end(new Error('scanner_unavailable')));
    socket.on('connect',()=> {
      socket.write('zINSTREAM\0');
      for(let offset=0;offset<buffer.length;offset+=65536) {
        const chunk=buffer.subarray(offset,offset+65536), length=Buffer.alloc(4);
        length.writeUInt32BE(chunk.length);socket.write(length);socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
    socket.on('data',chunk=> {
      answer+=chunk.toString('utf8');
      if(answer.length>4096) return end(new Error('invalid_scanner_response'));
      if(answer.includes('\0')) {
        if(answer.trim().replace(/\0/g,'')==='stream: OK') return end();
        if(answer.includes(' FOUND')) return end(Object.assign(new Error('infected_file'),{code:'infected_file'}));
        end(new Error('scanner_failed'));
      }
    });
    socket.on('end',()=> {if(!answer.includes('\0'))end(new Error('scanner_incomplete'));});
  });
}
