// A screen-space deformation mesh, not reconstructed scene geometry.
// Positive horizontal cell widths + fixed endpoints guarantee coverage/no folds.
export function makeElasticGrid(bytes, width, height, strength, columns=193, rows=109) {
    if (bytes.length !== width*height || !Number.isFinite(strength) || strength<0 || strength>2
        || columns<2 || rows<2) throw Error('Invalid elastic mesh inputs');
    const targets=new Float32Array(columns*rows*2),depth=new Float64Array(columns);
    const step=1/(columns-1),delta=new Float64Array(columns-1);
    for(let y=0;y<rows;y++) {
        // Texture mesh coordinates go bottom-to-top; depth bytes are top-to-bottom.
        const sy=(1-y/(rows-1))*(height-1);
        for(let x=0;x<columns;x++) {
            const sx=x/(columns-1)*(width-1);let total=0,weight=0;
            for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) {
                const ix=Math.max(0,Math.min(width-1,Math.round(sx)+dx));
                const iy=Math.max(0,Math.min(height-1,Math.round(sy)+dy));
                const w=(dx===0?2:1)*(dy===0?2:1);total+=bytes[iy*width+ix]*w;weight+=w;
            }
            depth[x]=total/(255*weight);
        }
        for(let eye=0;eye<2;eye++) {
            let total=0;
            for(let x=0;x<columns-1;x++) {
                const desired=step+(eye===0?1:-1)*.016*strength*(depth[x+1]-depth[x]);
                delta[x]=Math.max(step*.2,Math.min(step*5,desired));total+=delta[x];
            }
            let sum=0;targets[(y*columns)*2+eye]=0;
            for(let x=1;x<columns;x++) {sum+=delta[x-1];targets[(y*columns+x)*2+eye]=x===columns-1?1:sum/total;}
        }
    }
    return {targets,columns,rows};
}
export const elasticVertex=`#version 300 es
precision highp float;
uniform sampler2D elasticMap;uniform ivec2 grid;uniform float eye;
out vec3 projected;flat out float rejected;
void main(){
 int cell=gl_VertexID/6;int corner=gl_VertexID%6;
 ivec2 offsets[6]=ivec2[6](ivec2(0,0),ivec2(1,0),ivec2(0,1),ivec2(1,0),ivec2(1,1),ivec2(0,1));
 ivec2 p=ivec2(cell%(grid.x-1),cell/(grid.x-1))+offsets[corner];
 vec2 uv=vec2(p)/vec2(grid-1);vec2 target=texelFetch(elasticMap,p,0).rg;
 gl_Position=vec4(2.*(eye>0.?target.r:target.g)-1.,2.*uv.y-1.,0.,1.);
 projected=vec3(uv,1.);rejected=0.;
}`;
