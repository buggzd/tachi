precision highp float;
precision highp int;
layout(std430, binding=0) readonly buffer RawDepth { float raw[]; };
layout(std430, binding=1) buffer State { uint s[]; };
layout(std430, binding=2) buffer History { float previous[]; };
layout(std430, binding=3) buffer Appearance { uint previousColor[]; };
layout(binding=2) uniform highp sampler2D rgba;
#define LO 512
#define HI 513
#define LRANK 514
#define HRANK 515
#define BAD 516
#define DIFF 517
#define INITIAL 518
#define ACCEPT 519
#define RESET 520
#define LOW 521
#define HIGH 522
uint ordered(float v) {
    uint b=floatBitsToUint(v);
    return (b & 0x80000000u)!=0u ? ~b : b ^ 0x80000000u;
}
float unordered(uint k) {
    return uintBitsToFloat((k & 0x80000000u)!=0u ? k ^ 0x80000000u : ~k);
}
uvec3 rgb(uint i) {
    return uvec3(floor(texelFetch(rgba,ivec2(int(i)%W,int(i)/W),0).rgb*255.0+0.5));
}
uint colorDifference(uint i, uvec3 color) {
    uint old=previousColor[i];
    ivec3 diff=abs(ivec3(color)-ivec3(int(old&255u),int((old>>8u)&255u),int((old>>16u)&255u)));
    return uint(diff.r+diff.g+diff.b);
}
