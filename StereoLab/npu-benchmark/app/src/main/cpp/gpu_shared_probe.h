#ifdef TACHI_QNN_SHARED_PROBE
// Isolated capability test: GPU writes shared input, HTP executes, GPU validates shared output.
// No production backend or vendor headers are embedded by this probe.
#include "QNN/HTP/QnnHtpMem.h"
#include <android/hardware_buffer.h>
#include <android/hardware_buffer_jni.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl31.h>
#include <GLES2/gl2ext.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <cstring>
#include <unistd.h>

namespace {
template <typename Api>
std::string runGpuSharedProbe(const Api& api, Qnn_ContextHandle_t context, Qnn_GraphHandle_t graph,
                             Qnn_Tensor_t input, Qnn_Tensor_t outputTensor) {
    std::ostringstream report;
    EGLDisplay display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    EGLContext glContext = EGL_NO_CONTEXT;
    EGLSurface surface = EGL_NO_SURFACE;
    AHardwareBuffer* hardware[2] = {nullptr, nullptr};
    void* mappings[2] = {MAP_FAILED, MAP_FAILED};
    int exportedFds[2] = {-1, -1};
    Qnn_MemHandle_t handles[2] = {nullptr, nullptr};
    GLuint buffers[3] = {}, program = 0;
    bool initialized = false;
    bool cleanupPass = true;
    auto cleanup = [&]() {
        if (glContext != EGL_NO_CONTEXT) { glDeleteBuffers(3, buffers); glDeleteProgram(program); }
        for (int i = 0; i < 2; ++i) {
            if (handles[i]) {
                auto status = api.memDeRegister(&handles[i], 1);
                report << "gpuSharedDeregister[" << i << "]=" << hexError(status) << "\n";
                cleanupPass = cleanupPass && status == QNN_SUCCESS;
            }
            if (mappings[i] != MAP_FAILED) munmap(mappings[i], 4096);
            if (exportedFds[i] >= 0) close(exportedFds[i]);
            if (hardware[i]) AHardwareBuffer_release(hardware[i]);
        }
        if (initialized) {
            eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
            if (surface != EGL_NO_SURFACE) eglDestroySurface(display, surface);
            if (glContext != EGL_NO_CONTEXT) eglDestroyContext(display, glContext);
            eglTerminate(display);
        }
    };
    auto fail = [&](const char* stage) {
        report << "gpuShared=FAIL stage=" << stage << " gl=" << glGetError() << "\n";
        cleanup(); return report.str();
    };
    if (!eglInitialize(display, nullptr, nullptr)) return fail("eglInitialize");
    initialized = true;
    EGLint attributes[] = {EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
                           EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_NONE};
    EGLConfig config; EGLint count = 0;
    if (!eglChooseConfig(display, attributes, &config, 1, &count) || !count) return fail("eglConfig");
    EGLint contextAttributes[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
    glContext = eglCreateContext(display, config, EGL_NO_CONTEXT, contextAttributes);
    EGLint surfaceAttributes[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
    surface = eglCreatePbufferSurface(display, config, surfaceAttributes);
    if (!eglMakeCurrent(display, surface, surface, glContext)) return fail("eglMakeCurrent");
    const char* ext = reinterpret_cast<const char*>(glGetString(GL_EXTENSIONS));
    if (!ext || std::string(ext).find("GL_EXT_external_buffer") == std::string::npos) return fail("externalBufferMissing");
    auto getClient = reinterpret_cast<PFNEGLGETNATIVECLIENTBUFFERANDROIDPROC>(eglGetProcAddress("eglGetNativeClientBufferANDROID"));
    auto storage = reinterpret_cast<PFNGLBUFFERSTORAGEEXTERNALEXTPROC>(eglGetProcAddress("glBufferStorageExternalEXT"));
    if (!getClient || !storage) return fail("externalBufferSymbols");
    glGenBuffers(3, buffers);
    for (int i = 0; i < 2; ++i) {
        AHardwareBuffer_Desc desc{};
        desc.width = 4096; desc.height = 1; desc.layers = 1;
        desc.format = AHARDWAREBUFFER_FORMAT_BLOB;
        desc.usage = AHARDWAREBUFFER_USAGE_GPU_DATA_BUFFER | AHARDWAREBUFFER_USAGE_CPU_READ_OFTEN
                     | AHARDWAREBUFFER_USAGE_CPU_WRITE_OFTEN;
        if (AHardwareBuffer_allocate(&desc, &hardware[i])) return fail("allocate");
        // Public NDK handle transport exports DMA-BUF fd(s) through SCM_RIGHTS.
        // Validate the data fd of our own linear BLOB; never assume a vendor native_handle layout.
        int sockets[2];
        if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sockets)) return fail("socketPair");
        int sent = AHardwareBuffer_sendHandleToUnixSocket(hardware[i], sockets[0]);
        char payload[4096], control[CMSG_SPACE(sizeof(int) * 64)]{};
        iovec vector{payload, sizeof(payload)};
        msghdr message{}; message.msg_iov = &vector; message.msg_iovlen = 1;
        message.msg_control = control; message.msg_controllen = sizeof(control);
        int received = sent == 0 ? recvmsg(sockets[1], &message, MSG_DONTWAIT | MSG_CMSG_CLOEXEC) : -1;
        close(sockets[0]); close(sockets[1]);
        std::vector<int> receivedFds;
        if (received >= 0) for (cmsghdr* header = CMSG_FIRSTHDR(&message); header; header = CMSG_NXTHDR(&message, header)) {
            if (header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS) continue;
            size_t count = (header->cmsg_len - CMSG_LEN(0)) / sizeof(int);
            const auto* fds = reinterpret_cast<const int*>(CMSG_DATA(header));
            for (size_t f = 0; f < count; ++f) receivedFds.push_back(fds[f]);
        }
        report << "gpuSharedExport fdCount=" << receivedFds.size() << " sent=" << sent << " received=" << received << "\n";
        // A BLOB may also export a metadata fd. Identify data by read-only comparison against
        // bytes written using the public AHardwareBuffer lock; never write a guessed metadata fd.
        uint8_t expected[4096];
        for (int k = 0; k < 4096; ++k) expected[k] = (k * 37 + k / 13 + 71) & 255;
        void* locked = nullptr;
        int lockStatus = AHardwareBuffer_lock(hardware[i], AHARDWAREBUFFER_USAGE_CPU_WRITE_OFTEN, -1, nullptr, &locked);
        if (lockStatus == 0) {
            std::memcpy(locked, expected, sizeof(expected));
            lockStatus = AHardwareBuffer_unlock(hardware[i], nullptr);
        }
        int matches = 0;
        for (int fd : receivedFds) {
            struct stat info{};
            void* candidate = MAP_FAILED;
            if (lockStatus == 0 && !(message.msg_flags & MSG_CTRUNC) && fstat(fd, &info) == 0 && info.st_size >= 4096)
                candidate = mmap(nullptr, 4096, PROT_READ, MAP_SHARED, fd, 0);
            bool match = candidate != MAP_FAILED && std::memcmp(candidate, expected, sizeof(expected)) == 0;
            if (candidate != MAP_FAILED) munmap(candidate, 4096);
            if (match && matches++ == 0) exportedFds[i] = fd; else close(fd);
        }
        report << "gpuSharedDataFdMatches=" << matches << "\n";
        if (matches != 1) return fail("unambiguousDataFdRequired");
        mappings[i] = mmap(nullptr, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, exportedFds[i], 0);
        if (mappings[i] == MAP_FAILED) return fail("mmap");
        Qnn_MemDescriptor_t memory = QNN_MEM_DESCRIPTOR_INIT;
        memory.memShape.numDim = input.v1.rank;
        memory.memShape.dimSize = input.v1.dimensions;
        memory.dataType = QNN_DATATYPE_UFIXED_POINT_8;
        QnnMemHtp_Descriptor_t htp{};
        htp.type = QNN_HTP_MEM_SHARED_BUFFER;
        htp.size = 4096;
        htp.sharedBufferConfig.fd = exportedFds[i];
        htp.sharedBufferConfig.offset = 0;
        memory.memType = QNN_MEM_TYPE_CUSTOM;
        memory.customInfo = &htp;
        __android_log_print(ANDROID_LOG_INFO, "TachiQnnDirectProbe", "gpuSharedStage=register index=%d", i);
        auto status = api.memRegister(context, &memory, 1, &handles[i]);
        report << "gpuSharedRegister[" << i << "]=" << hexError(status) << "\n";
        if (status != QNN_SUCCESS) return fail("memRegister");
        glBindBuffer(GL_SHADER_STORAGE_BUFFER, buffers[i]);
        storage(GL_SHADER_STORAGE_BUFFER, 0, 4096, getClient(hardware[i]), 0);
        if (glGetError() != GL_NO_ERROR) return fail("externalStorage");
    }
    glBindBuffer(GL_SHADER_STORAGE_BUFFER, buffers[2]);
    glBufferData(GL_SHADER_STORAGE_BUFFER, 4, nullptr, GL_DYNAMIC_READ);
    const char* source = R"(#version 310 es
precision highp float;
precision highp int;
layout(local_size_x=1) in;
layout(std430,binding=0) buffer Input {uint inputWords[];};
layout(std430,binding=1) readonly buffer Output {uint outputWords[];};
layout(std430,binding=2) buffer Status {uint errors;};
uniform uint iteration;
uniform int phase;
void main() {
 if (phase==0) {
  for(uint w=0u;w<4u;w++){uint packed=0u;for(uint b=0u;b<4u;b++)packed|=((iteration*17u+(w*4u+b)*29u)&255u)<<(b*8u);inputWords[w]=packed;}
 } else {
  errors=0u;
  for(uint w=0u;w<4u;w++)for(uint b=0u;b<4u;b++){
   uint expected=max((iteration*17u+(w*4u+b)*29u)&255u,128u);
   if(((outputWords[w]>>(b*8u))&255u)!=expected)errors++;
  }
 }
})";
    GLuint shader = glCreateShader(GL_COMPUTE_SHADER);
    glShaderSource(shader, 1, &source, nullptr); glCompileShader(shader);
    GLint good = 0; glGetShaderiv(shader, GL_COMPILE_STATUS, &good);
    if (!good) { glDeleteShader(shader); return fail("shader"); }
    program = glCreateProgram(); glAttachShader(program, shader); glLinkProgram(program); glDeleteShader(shader);
    glGetProgramiv(program, GL_LINK_STATUS, &good); if (!good) return fail("link");
    input.v1.memType = outputTensor.v1.memType = QNN_TENSORMEMTYPE_MEMHANDLE;
    input.v1.memHandle = handles[0]; outputTensor.v1.memHandle = handles[1];
    for (int i = 0; i < 100; ++i) {
        glUseProgram(program);
        for (int b = 0; b < 3; ++b) glBindBufferBase(GL_SHADER_STORAGE_BUFFER, b, buffers[b]);
        glUniform1ui(glGetUniformLocation(program, "iteration"), i);
        glUniform1i(glGetUniformLocation(program, "phase"), 0);
        glDispatchCompute(1, 1, 1); glMemoryBarrier(GL_ALL_BARRIER_BITS); glFinish();
        auto status = api.graphExecute(graph, &input, 1, &outputTensor, 1, nullptr, nullptr);
        if (status != QNN_SUCCESS) { report << "gpuSharedExecute=" << hexError(status) << "\n"; return fail("execute"); }
        glMemoryBarrier(GL_ALL_BARRIER_BITS);
        glUniform1i(glGetUniformLocation(program, "phase"), 1);
        glDispatchCompute(1, 1, 1); glMemoryBarrier(GL_BUFFER_UPDATE_BARRIER_BIT); glFinish();
        glBindBuffer(GL_SHADER_STORAGE_BUFFER, buffers[2]);
        const auto* errors = static_cast<const uint32_t*>(glMapBufferRange(GL_SHADER_STORAGE_BUFFER, 0, 4, GL_MAP_READ_BIT));
        if (!errors) return fail("statusMap");
        bool match = *errors == 0; glUnmapBuffer(GL_SHADER_STORAGE_BUFFER);
        if (!match) { report << "gpuSharedMismatchIteration=" << i << "\n"; return fail("values"); }
    }
    cleanup();
    report << "gpuShared=" << (cleanupPass ? "PASS" : "FAIL")
           << " iterations=100 hostImageCopies=0 statusReadBytesPerIteration=4\n";
    return report.str();
}
}

#else
namespace {
template <typename Api>
std::string runGpuSharedProbe(const Api&, Qnn_ContextHandle_t, Qnn_GraphHandle_t,
                             Qnn_Tensor_t, Qnn_Tensor_t) {
    return "gpuShared=UNAVAILABLE matchingSdkHeadersRequired=true\n";
}
}
#endif
