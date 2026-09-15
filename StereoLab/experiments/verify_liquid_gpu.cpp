// Standalone Android GLES verifier. No app, network, video identity or QNN dependency.
// Compile with NDK clang++: -std=c++17 -O2 -static-libstdc++ -lEGL -lGLESv3.
// Arguments: shader directory, optional 392x224 R8 depth frame, optional timing repeats.
#include <EGL/egl.h>
#include <GLES3/gl31.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

static void check(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
static std::string read(const std::string& path)
{
    std::ifstream f(path, std::ios::binary); check(bool(f), "input missing");
    return {std::istreambuf_iterator<char>(f), {}};
}
static GLuint shader(GLenum type, const std::string& source)
{
    GLuint s = glCreateShader(type); const char* p = source.c_str();
    glShaderSource(s, 1, &p, nullptr); glCompileShader(s); GLint ok;
    glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) { char log[4096]; glGetShaderInfoLog(s, sizeof(log), nullptr, log); std::cerr << log; }
    check(ok, "shader compile"); return s;
}
static GLuint program(const std::string& source, bool compute)
{
    GLuint p = glCreateProgram(); std::vector<GLuint> shaders;
    if (compute) shaders.push_back(shader(GL_COMPUTE_SHADER, source));
    else
    {
        shaders.push_back(shader(GL_VERTEX_SHADER, "#version 300 es\nout vec2 uv;void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));uv=p;gl_Position=vec4(p*2.-1.,0.,1.);}"));
        shaders.push_back(shader(GL_FRAGMENT_SHADER, source));
    }
    for (auto s : shaders) glAttachShader(p, s);
    glLinkProgram(p); GLint ok; glGetProgramiv(p, GL_LINK_STATUS, &ok); check(ok, "program link");
    for (auto s : shaders) glDeleteShader(s); return p;
}
static GLuint texture(int w, int h, GLenum internal, const void* bytes = nullptr)
{
    GLuint t; glGenTextures(1, &t); glBindTexture(GL_TEXTURE_2D, t);
    glTexStorage2D(GL_TEXTURE_2D, 1, internal, w, h);
    if (bytes) glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, w, h, internal == GL_R8 ? GL_RED : GL_RGBA, GL_UNSIGNED_BYTE, bytes);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, internal == GL_RGBA32F ? GL_NEAREST : GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, internal == GL_RGBA32F ? GL_NEAREST : GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE); return t;
}
static void bind(int unit, GLuint t) { glActiveTexture(GL_TEXTURE0 + unit); glBindTexture(GL_TEXTURE_2D, t); }
static GLuint field(GLuint p, bool fused, GLuint depth, GLuint* maps, int w, int h)
{
    glUseProgram(p); bind(0, depth); int step = fused ? 2 : 1; GLuint previous = maps[0];
    for (int phase = 0; phase <= 8; phase += step)
    {
        GLuint dst = phase == 0 ? maps[0] : maps[1 + (phase / step - 1) % 2];
        bind(1, phase == 0 ? depth : maps[0]); bind(2, phase == 0 ? depth : previous);
        glBindImageTexture(0, dst, 0, GL_FALSE, 0, GL_WRITE_ONLY, GL_RGBA32F);
        glUniform1i(glGetUniformLocation(p, "phase"), phase);
        glDispatchCompute((w + 7) / 8, (h + 7) / 8, 1);
        glMemoryBarrier(GL_SHADER_IMAGE_ACCESS_BARRIER_BIT | GL_TEXTURE_FETCH_BARRIER_BIT);
        previous = dst;
    }
    return previous;
}
static void target(GLuint t)
{
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, t, 0);
    check(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE, "float framebuffer");
}
static void render(GLuint p, GLuint video, GLuint depth, GLuint map, float eye, int debug)
{
    glUseProgram(p); bind(0, video); bind(1, depth); bind(2, map);
    glUniform1i(glGetUniformLocation(p, "video"), 0); glUniform1i(glGetUniformLocation(p, "depthMap"), 1);
    glUniform1i(glGetUniformLocation(p, "liquidMap"), 2);
    glUniform1f(glGetUniformLocation(p, "eye"), eye);
    glUniform1i(glGetUniformLocation(p, "depthOnly"), 0); glUniform1i(glGetUniformLocation(p, "debugLiquid"), debug);
    glDrawArrays(GL_TRIANGLES, 0, 3);
}
template<class F, class G> static std::pair<double,double> pairedTime(F a, G b, int count)
{
    for(int i=0;i<3;i++){a();glFinish();b();glFinish();}
    std::vector<double> av,bv;
    auto sample=[](auto f){auto start=std::chrono::steady_clock::now();f();glFinish();
        return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();};
    for(int i=0;i<count;i++)
    {
        if(i%2){bv.push_back(sample(b));av.push_back(sample(a));}
        else{av.push_back(sample(a));bv.push_back(sample(b));}
    }
    std::sort(av.begin(),av.end());std::sort(bv.begin(),bv.end());return {av[count/2],bv[count/2]};
}
int main(int argc, char** argv)
{
    try
    {
        check(argc >= 2, "shader directory required");
        int repeats = argc >= 4 ? std::stoi(argv[3]) : 7; check(repeats >= 1 && repeats <= 30, "repeats range");
        EGLDisplay display = eglGetDisplay(EGL_DEFAULT_DISPLAY); check(eglInitialize(display, nullptr, nullptr), "EGL init");
        EGLint attrs[] = {EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_NONE};
        EGLConfig config; EGLint n; check(eglChooseConfig(display, attrs, &config, 1, &n) && n, "EGL config");
        EGLint ca[] = {EGL_CONTEXT_CLIENT_VERSION,3,EGL_NONE}, sa[] = {EGL_WIDTH,1,EGL_HEIGHT,1,EGL_NONE};
        EGLContext context = eglCreateContext(display, config, EGL_NO_CONTEXT, ca);
        EGLSurface surface = eglCreatePbufferSurface(display, config, sa);
        check(eglMakeCurrent(display, surface, surface, context), "EGL current");
        glPixelStorei(GL_UNPACK_ALIGNMENT, 1); glDisable(GL_DITHER);
        std::string root = argv[1];
        GLuint programs[] = {program(read(root+"/field.comp"),true), program(read(root+"/field-fused.comp"),true),
            program(read(root+"/render.frag"),false), program(read(root+"/render-cached.frag"),false)};
        GLuint fbo; glGenFramebuffers(1, &fbo); glBindFramebuffer(GL_FRAMEBUFFER, fbo);
        GLuint vao; glGenVertexArrays(1, &vao); glBindVertexArray(vao);
        const int rw = 1920, rh = 1080;
        std::vector<unsigned char> color(rw*rh*4), a(color.size()), b(color.size());
        for (int y=0;y<rh;y++) for(int x=0;x<rw;x++)
        {
            int i=(y*rw+x)*4; color[i]=(x*37+y*13)%256; color[i+1]=(x/7+y/5)%2?255:0;
            color[i+2]=(x*11+y*29)%256; color[i+3]=255;
        }
        GLuint video=texture(rw,rh,GL_RGBA8,color.data()), output=texture(rw,rh,GL_RGBA8);
        std::cout << "{\"scope\":\"Android GLES actual workgroups; synthetic RGB, optional real depth. Alternating glFinish wall medians are isolated workload timings, not product FPS.\",\"cases\":[";
        for (int c=0;c<7;c++)
        {
            if(c==6 && argc<3) break;
            int w=c==0?1:c==1?7:c==5?518:c==6?392:131;
            int h=c==0?1:c==1?9:c==5?294:c==6?224:67;
            std::vector<unsigned char> depthBytes(w*h);
            for(int y=0;y<h;y++)for(int x=0;x<w;x++)
                depthBytes[y*w+x]=c==0?180:c==2?(x>w/2?230:20):c==3?(x>w/2&&y!=h/2?230:20):(x*17+y*31)%256;
            if(c==6){auto raw=read(argv[2]);check(raw.size()==depthBytes.size(),"depth frame size");std::copy(raw.begin(),raw.end(),depthBytes.begin());}
            GLuint depth=texture(w,h,GL_R8,depthBytes.data()), maps[6];
            for(auto &t:maps)t=texture(w,h,GL_RGBA32F);
            GLuint ref=field(programs[0],false,depth,maps,w,h), fused=field(programs[1],true,depth,maps+3,w,h);
            std::vector<float> fa(w*h*4),fb(fa.size());
            target(ref);glReadPixels(0,0,w,h,GL_RGBA,GL_FLOAT,fa.data());
            target(fused);glReadPixels(0,0,w,h,GL_RGBA,GL_FLOAT,fb.data());
            double error=0;
            for(size_t i=0;i<fa.size();i++) {check(std::isfinite(fa[i])&&std::isfinite(fb[i]),"nonfinite map");if(i%4<2)error=std::max(error,double(std::abs(fa[i]-fb[i]))*1920);}
            check(error<.002,"fused field mismatch");
            target(output);glViewport(0,0,rw,rh);
            int renderError=0, combinedError=0;long changed=0;
            // Both eyes, plus coverage debug. Keep reference map for isolated cache check.
            for(float eye:{-1.f,1.f})for(int debug:{0,1})
            {
                render(programs[2],video,depth,ref,eye,debug);glReadPixels(0,0,rw,rh,GL_RGBA,GL_UNSIGNED_BYTE,a.data());
                render(programs[3],video,depth,ref,eye,debug);glReadPixels(0,0,rw,rh,GL_RGBA,GL_UNSIGNED_BYTE,b.data());
                for(size_t i=0;i<a.size();i++){int d=std::abs(int(a[i])-int(b[i]));renderError=std::max(renderError,d);changed+=d!=0;}
                render(programs[3],video,depth,fused,eye,debug);glReadPixels(0,0,rw,rh,GL_RGBA,GL_UNSIGNED_BYTE,b.data());
                for(size_t i=0;i<a.size();i++)combinedError=std::max(combinedError,std::abs(int(a[i])-int(b[i])));
            }
            check(renderError==0,"cached render mismatch");check(combinedError<=1,"combined render mismatch");
            auto ft=pairedTime([&]{field(programs[0],false,depth,maps,w,h);},
                [&]{field(programs[1],true,depth,maps+3,w,h);},repeats);
            double oldMs=ft.first,newMs=ft.second;
            target(output);
            auto rt=pairedTime([&]{render(programs[2],video,depth,ref,1,0);},
                [&]{render(programs[3],video,depth,ref,1,0);},repeats);
            double renderMs=rt.first,cachedMs=rt.second;
            check(glGetError()==GL_NO_ERROR,"GL error");
            if(c)std::cout<<",";
            std::cout<<"{\"case\":"<<c<<",\"width\":"<<w<<",\"height\":"<<h<<",\"fieldMaxErrorPx\":"<<error
                <<",\"cachedMaxChannelError\":"<<renderError<<",\"cachedChangedChannels\":"<<changed<<",\"combinedMaxChannelError\":"<<combinedError
                <<",\"fieldMs\":"<<oldMs<<",\"fusedMs\":"<<newMs<<",\"renderMs\":"<<renderMs<<",\"cachedMs\":"<<cachedMs<<"}"<<std::flush;
            glDeleteTextures(1,&depth);glDeleteTextures(6,maps);
        }
        std::cout<<"]}"<<std::endl;
        glDeleteTextures(1,&video);glDeleteTextures(1,&output);glDeleteFramebuffers(1,&fbo);glDeleteVertexArrays(1,&vao);
        for(auto p:programs)glDeleteProgram(p);
        eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);eglDestroySurface(display,surface);eglDestroyContext(display,context);eglTerminate(display);
        return 0;
    }
    catch(const std::exception& e){std::cerr<<e.what()<<std::endl;return 1;}
}
