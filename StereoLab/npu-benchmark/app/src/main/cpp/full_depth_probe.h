#pragma once
#if defined(TACHI_QNN_SHARED_PROBE)
#include "QNN/System/QnnSystemInterface.h"
#include <fstream>
#include <dirent.h>
#include <chrono>
#include <stdexcept>

namespace {
std::vector<uint8_t> depthFile(const std::string& path) {
    std::ifstream stream(path, std::ios::binary | std::ios::ate);
    auto size = stream.tellg();
    if (!stream || size <= 0 || size > 256 * 1024 * 1024) throw std::runtime_error("bounded file");
    std::vector<uint8_t> result(static_cast<size_t>(size));
    stream.seekg(0); stream.read(reinterpret_cast<char*>(result.data()), size);
    if (!stream) throw std::runtime_error("file read");
    return result;
}
uint32_t tensorRank(const Qnn_Tensor_t& t) { return t.version == QNN_TENSOR_VERSION_1 ? t.v1.rank : t.v2.rank; }
uint32_t* tensorDimensions(const Qnn_Tensor_t& t) { return t.version == QNN_TENSOR_VERSION_1 ? t.v1.dimensions : t.v2.dimensions; }
Qnn_DataType_t tensorType(const Qnn_Tensor_t& t) { return t.version == QNN_TENSOR_VERSION_1 ? t.v1.dataType : t.v2.dataType; }
size_t tensorFloats(const Qnn_Tensor_t& t) {
    if ((t.version != QNN_TENSOR_VERSION_1 && t.version != QNN_TENSOR_VERSION_2)
            || tensorType(t) != QNN_DATATYPE_FLOAT_32 || tensorRank(t) < 1 || tensorRank(t) > 4)
        throw std::runtime_error("float32 rank required");
    size_t count = 1;
    for (uint32_t i = 0; i < tensorRank(t); ++i) {
        uint32_t d = tensorDimensions(t)[i];
        if (!d || d > 2048) throw std::runtime_error("tensor dimension");
        count *= d;
        if (count > 4 * 1024 * 1024) throw std::runtime_error("tensor size");
    }
    return count;
}
void tensorRaw(Qnn_Tensor_t& t, void* data, size_t bytes) {
    if (t.version == QNN_TENSOR_VERSION_1) { t.v1.memType = QNN_TENSORMEMTYPE_RAW; t.v1.clientBuf = {data, static_cast<uint32_t>(bytes)}; }
    else { t.v2.memType = QNN_TENSORMEMTYPE_RAW; t.v2.clientBuf = {data, static_cast<uint32_t>(bytes)}; }
}
void tensorShared(Qnn_Tensor_t& t, Qnn_MemHandle_t handle) {
    if (t.version == QNN_TENSOR_VERSION_1) { t.v1.memType = QNN_TENSORMEMTYPE_MEMHANDLE; t.v1.memHandle = handle; }
    else { t.v2.memType = QNN_TENSORMEMTYPE_MEMHANDLE; t.v2.memHandle = handle; }
}

// Owns the public AHardwareBuffer, exported data fd and imported GLES storage.
// Initial CPU initialization is only for fd identification; execution never maps image storage.
struct DepthSharedBuffer {
    AHardwareBuffer* hardware = nullptr;
    int fd = -1;
    GLuint buffer = 0;
    size_t bytes = 0;
    ~DepthSharedBuffer() {
        if (buffer) glDeleteBuffers(1, &buffer);
        if (fd >= 0) close(fd);
        if (hardware) AHardwareBuffer_release(hardware);
    }
    bool allocate(size_t requested) {
        bytes = (std::max<size_t>(4096, requested) + 4095) & ~size_t(4095);
        AHardwareBuffer_Desc desc{};
        desc.width = bytes; desc.height = 1; desc.layers = 1; desc.format = AHARDWAREBUFFER_FORMAT_BLOB;
        desc.usage = AHARDWAREBUFFER_USAGE_GPU_DATA_BUFFER | AHARDWAREBUFFER_USAGE_CPU_WRITE_OFTEN | AHARDWAREBUFFER_USAGE_CPU_READ_OFTEN;
        if (AHardwareBuffer_allocate(&desc, &hardware)) return false;
        uint8_t expected[4096];
        for (int i = 0; i < 4096; ++i) expected[i] = (i * 37 + i / 13 + 71) & 255;
        void* locked = nullptr;
        if (AHardwareBuffer_lock(hardware, AHARDWAREBUFFER_USAGE_CPU_WRITE_OFTEN, -1, nullptr, &locked)) return false;
        std::memcpy(locked, expected, sizeof(expected));
        if (AHardwareBuffer_unlock(hardware, nullptr)) return false;
        int sockets[2];
        if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sockets)) return false;
        int sent = AHardwareBuffer_sendHandleToUnixSocket(hardware, sockets[0]);
        char payload[4096], control[CMSG_SPACE(sizeof(int) * 64)]{};
        iovec vector{payload, sizeof(payload)}; msghdr message{};
        message.msg_iov = &vector; message.msg_iovlen = 1;
        message.msg_control = control; message.msg_controllen = sizeof(control);
        int received = sent == 0 ? recvmsg(sockets[1], &message, MSG_DONTWAIT | MSG_CMSG_CLOEXEC) : -1;
        close(sockets[0]); close(sockets[1]);
        int matches = 0;
        if (received >= 0) for (cmsghdr* h = CMSG_FIRSTHDR(&message); h; h = CMSG_NXTHDR(&message, h)) {
            if (h->cmsg_level != SOL_SOCKET || h->cmsg_type != SCM_RIGHTS) continue;
            size_t n = (h->cmsg_len - CMSG_LEN(0)) / sizeof(int);
            auto* fds = reinterpret_cast<int*>(CMSG_DATA(h));
            for (size_t i = 0; i < n; ++i) {
                struct stat info{}; void* candidate = MAP_FAILED;
                if (!(message.msg_flags & MSG_CTRUNC) && fstat(fds[i], &info) == 0 && info.st_size >= static_cast<off_t>(bytes))
                    candidate = mmap(nullptr, 4096, PROT_READ, MAP_SHARED, fds[i], 0);
                bool match = candidate != MAP_FAILED && std::memcmp(candidate, expected, 4096) == 0;
                if (candidate != MAP_FAILED) munmap(candidate, 4096);
                if (match && matches++ == 0) fd = fds[i]; else close(fds[i]);
            }
        }
        if (matches != 1) return false;
        auto getClient = reinterpret_cast<PFNEGLGETNATIVECLIENTBUFFERANDROIDPROC>(eglGetProcAddress("eglGetNativeClientBufferANDROID"));
        auto storage = reinterpret_cast<PFNGLBUFFERSTORAGEEXTERNALEXTPROC>(eglGetProcAddress("glBufferStorageExternalEXT"));
        if (!getClient || !storage) return false;
        glGenBuffers(1, &buffer); glBindBuffer(GL_SHADER_STORAGE_BUFFER, buffer);
        storage(GL_SHADER_STORAGE_BUFFER, 0, bytes, getClient(hardware), 0);
        return glGetError() == GL_NO_ERROR;
    }
};

struct DepthGlContext {
    EGLDisplay display = EGL_NO_DISPLAY;
    EGLContext context = EGL_NO_CONTEXT;
    EGLSurface surface = EGL_NO_SURFACE;
    ~DepthGlContext() {
        if (display == EGL_NO_DISPLAY) return;
        eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
        if (surface != EGL_NO_SURFACE) eglDestroySurface(display, surface);
        if (context != EGL_NO_CONTEXT) eglDestroyContext(display, context);
        eglTerminate(display);
    }
    bool create() {
        display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
        if (!eglInitialize(display, nullptr, nullptr)) return false;
        const EGLint attributes[] = {EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT, EGL_NONE};
        EGLConfig config; EGLint count = 0;
        if (!eglChooseConfig(display, attributes, &config, 1, &count) || !count) return false;
        const EGLint ctx[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
        const EGLint size[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
        context = eglCreateContext(display, config, EGL_NO_CONTEXT, ctx);
        surface = eglCreatePbufferSurface(display, config, size);
        return eglMakeCurrent(display, surface, surface, context);
    }
};

template<class Api>
std::string depthGpu(const Api& api, Qnn_ContextHandle_t context, Qnn_GraphHandle_t graph,
                     Qnn_Tensor_t input, Qnn_Tensor_t output,
                     const std::vector<std::vector<uint8_t>>& inputs,
                     const std::vector<std::vector<uint8_t>>& expected) {
    std::ostringstream report;
    DepthGlContext gl;
    if (!gl.create()) return "fullDepthShared=FAIL stage=egl\n";
    DepthSharedBuffer buffers[2];
    Qnn_MemHandle_t handles[2]{};
    GLuint storage[3]{}, program = 0;
    bool deregistered = true;
    auto cleanup = [&]() {
        for (auto& handle : handles) if (handle) {
            deregistered &= api.memDeRegister(&handle, 1) == QNN_SUCCESS; handle = nullptr;
        }
        if (program) glDeleteProgram(program);
        glDeleteBuffers(3, storage);
    };
    try {
        Qnn_Tensor_t tensors[] = {input, output};
        for (int i = 0; i < 2; ++i) {
            if (!buffers[i].allocate(tensorFloats(tensors[i]) * 4)) throw std::runtime_error("external buffer");
            Qnn_MemDescriptor_t memory = QNN_MEM_DESCRIPTOR_INIT;
            memory.memShape.numDim = tensorRank(tensors[i]); memory.memShape.dimSize = tensorDimensions(tensors[i]);
            memory.dataType = tensorType(tensors[i]); memory.memType = QNN_MEM_TYPE_CUSTOM;
            QnnMemHtp_Descriptor_t htp{};
            htp.type = QNN_HTP_MEM_SHARED_BUFFER; htp.size = buffers[i].bytes;
            htp.sharedBufferConfig.fd = buffers[i].fd; htp.sharedBufferConfig.offset = 0;
            memory.customInfo = &htp;
            auto status = api.memRegister(context, &memory, 1, &handles[i]);
            report << "fullDepthRegister[" << i << "]=" << hexError(status) << " bytes=" << buffers[i].bytes << "\n";
            if (status != QNN_SUCCESS) throw std::runtime_error("register");
        }
        tensorShared(input, handles[0]); tensorShared(output, handles[1]);
        glGenBuffers(3, storage);
        for (int i = 0; i < 2; ++i) {
            const auto& samples = i == 0 ? inputs : expected;
            std::vector<uint8_t> data;
            for (const auto& sample : samples) data.insert(data.end(), sample.begin(), sample.end());
            glBindBuffer(GL_SHADER_STORAGE_BUFFER, storage[i]);
            glBufferData(GL_SHADER_STORAGE_BUFFER, data.size(), data.data(), GL_STATIC_DRAW);
        }
        glBindBuffer(GL_SHADER_STORAGE_BUFFER, storage[2]);
        uint32_t zero = 0; glBufferData(GL_SHADER_STORAGE_BUFFER, 4, &zero, GL_DYNAMIC_READ);
        const char* source = R"(#version 310 es
precision highp float;
precision highp int;
layout(local_size_x=256) in;
layout(std430,binding=0) buffer Input {float inputValues[];};
layout(std430,binding=1) readonly buffer Output {float outputValues[];};
layout(std430,binding=2) readonly buffer ReferencesIn {float referencesIn[];};
layout(std430,binding=3) readonly buffer ReferencesOut {float referencesOut[];};
layout(std430,binding=4) buffer Status {uint errors;};
uniform uint inputCount;
uniform uint outputCount;
uniform uint sampleIndex;
uniform int phase;
void main() {
 uint i=gl_GlobalInvocationID.x;
 if(phase==0){if(i<inputCount)inputValues[i]=referencesIn[sampleIndex*inputCount+i];}
 else if(i<outputCount){float v=outputValues[i];float e=referencesOut[sampleIndex*outputCount+i];
  if(isnan(v)||isinf(v)||abs(v-e)>0.000001)atomicAdd(errors,1u);}
})";
        GLuint shader = glCreateShader(GL_COMPUTE_SHADER);
        glShaderSource(shader, 1, &source, nullptr); glCompileShader(shader);
        GLint ok = 0; glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
        if (!ok) { glDeleteShader(shader); throw std::runtime_error("shader"); }
        program = glCreateProgram(); glAttachShader(program, shader); glLinkProgram(program); glDeleteShader(shader);
        glGetProgramiv(program, GL_LINK_STATUS, &ok); if (!ok) throw std::runtime_error("link");
        glUseProgram(program);
        glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 0, buffers[0].buffer);
        glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 1, buffers[1].buffer);
        for (int i = 0; i < 3; ++i) glBindBufferBase(GL_SHADER_STORAGE_BUFFER, i + 2, storage[i]);
        size_t inCount = tensorFloats(input), outCount = tensorFloats(output);
        glUniform1ui(glGetUniformLocation(program, "inputCount"), inCount);
        glUniform1ui(glGetUniformLocation(program, "outputCount"), outCount);
        std::vector<double> executeMs, loopMs;
        for (int iteration = 0; iteration < 105; ++iteration) {
            auto start = std::chrono::steady_clock::now();
            glUniform1ui(glGetUniformLocation(program, "sampleIndex"), iteration % inputs.size());
            glUniform1i(glGetUniformLocation(program, "phase"), 0);
            glDispatchCompute((inCount + 255) / 256, 1, 1);
            glMemoryBarrier(GL_ALL_BARRIER_BITS); glFinish();
            auto before = std::chrono::steady_clock::now();
            auto status = api.graphExecute(graph, &input, 1, &output, 1, nullptr, nullptr);
            auto after = std::chrono::steady_clock::now();
            if (status != QNN_SUCCESS) { report << "execute=" << hexError(status) << "\n"; throw std::runtime_error("execute"); }
            glBindBuffer(GL_SHADER_STORAGE_BUFFER, storage[2]); glBufferSubData(GL_SHADER_STORAGE_BUFFER, 0, 4, &zero);
            glMemoryBarrier(GL_ALL_BARRIER_BITS);
            glUniform1i(glGetUniformLocation(program, "phase"), 1);
            glDispatchCompute((outCount + 255) / 256, 1, 1);
            glMemoryBarrier(GL_BUFFER_UPDATE_BARRIER_BIT); glFinish();
            const uint32_t* errors = static_cast<const uint32_t*>(glMapBufferRange(GL_SHADER_STORAGE_BUFFER, 0, 4, GL_MAP_READ_BIT));
            if (!errors) throw std::runtime_error("status map");
            uint32_t mismatch = *errors; glUnmapBuffer(GL_SHADER_STORAGE_BUFFER);
            if (mismatch || glGetError() != GL_NO_ERROR) {
                report << "mismatchIteration=" << iteration << " pixels=" << mismatch << "\n";
                throw std::runtime_error("gpu reference mismatch");
            }
            if (iteration >= 5) {
                executeMs.push_back(std::chrono::duration<double, std::milli>(after-before).count());
                loopMs.push_back(std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now()-start).count());
            }
        }
        auto metrics = [&](const char* name, std::vector<double> values) {
            double sum = 0; for (double value : values) sum += value;
            std::sort(values.begin(), values.end());
            report << name << " meanMs=" << sum / values.size() << " p95Ms=" << values[94] << "\n";
        };
        metrics("fullDepthExecute", executeMs); metrics("fullDepthSharedLoop", loopMs);
        cleanup();
        report << "fullDepthShared=" << (deregistered ? "PASS" : "FAIL")
               << " measuredIterations=100 warmup=5 imageReferences=" << inputs.size()
               << " hostImageCopiesPerIteration=0 statusReadBytesPerIteration=4 statusWriteBytesPerIteration=4 absoluteTolerance=0.000001\n";
    } catch (const std::exception& e) {
        cleanup(); report << "fullDepthShared=FAIL stage=" << e.what() << "\n";
    }
    return report.str();
}

template<class Api>
std::string runFullDepth(const Api& api, Qnn_BackendHandle_t backend, Qnn_DeviceHandle_t device,
                         const std::string& libraryDirectory, const std::string& directory) {
    std::ostringstream report;
    Qnn_ContextHandle_t context = nullptr;
    QnnSystemContext_Handle_t system = nullptr;
    void* library = nullptr;
    QNN_SYSTEM_INTERFACE_VER_TYPE systemApi{};
    std::vector<uint8_t> binary; // Keep metadata backing storage alive through context/system cleanup, including failures.
    auto cleanup = [&]() {
        if (context) {
            auto status = api.contextFree(context, nullptr); context = nullptr;
            report << "fullDepthContextFree=" << hexError(status) << "\n";
            if (status != QNN_SUCCESS) report << "fullDepthShared=FAIL stage=context_free\n";
        }
        if (system) { systemApi.systemContextFree(system); system = nullptr; }
        if (library) { dlclose(library); library = nullptr; }
    };
    try {
        DIR* dir = opendir(directory.c_str());
        if (!dir) throw std::runtime_error("cache directory");
        std::vector<std::string> binaries;
        while (dirent* entry = readdir(dir)) {
            std::string name = entry->d_name;
            if (name.size() > 4 && name.substr(name.size()-4) == ".bin") binaries.push_back(directory + "/" + name);
        }
        closedir(dir);
        if (binaries.size() != 1) throw std::runtime_error("one context binary required");
        binary = depthFile(binaries[0]);
        std::string error;
        library = openLibrary(libraryDirectory, "libQnnSystem.so", &error);
        if (!library) throw std::runtime_error("system library");
        using Providers = Qnn_ErrorHandle_t (*)(const QnnSystemInterface_t***, uint32_t*);
        auto getProviders = reinterpret_cast<Providers>(dlsym(library, "QnnSystemInterface_getProviders"));
        const QnnSystemInterface_t** providers = nullptr; uint32_t count = 0;
        if (!getProviders || getProviders(&providers, &count) != QNN_SUCCESS || !count) throw std::runtime_error("system provider");
        const QnnSystemInterface_t* provider = nullptr;
        for (uint32_t i = 0; i < count; ++i)
            if (providers[i] && providers[i]->systemApiVersion.major == QNN_SYSTEM_API_VERSION_MAJOR
                    && providers[i]->systemApiVersion.minor >= QNN_SYSTEM_API_VERSION_MINOR) { provider = providers[i]; break; }
        if (!provider) throw std::runtime_error("system API version");
        systemApi = provider->QNN_SYSTEM_INTERFACE_VER_NAME;
        if (!systemApi.systemContextCreate || !systemApi.systemContextGetBinaryInfo || !systemApi.systemContextFree
                || !api.contextCreateFromBinary || !api.contextFree || !api.graphRetrieve || !api.graphExecute
                || !api.memRegister || !api.memDeRegister) throw std::runtime_error("required API");
        if (systemApi.systemContextCreate(&system) != QNN_SUCCESS) throw std::runtime_error("system context");
        const QnnSystemContext_BinaryInfo_t* info = nullptr; Qnn_ContextBinarySize_t infoSize = 0;
        auto status = systemApi.systemContextGetBinaryInfo(system, binary.data(), binary.size(), &info, &infoSize);
        if (status != QNN_SUCCESS || !info) throw std::runtime_error("binary metadata");
        QnnSystemContext_GraphInfo_t* graphs = nullptr; uint32_t graphCount = 0;
        if (info->version == QNN_SYSTEM_CONTEXT_BINARY_INFO_VERSION_1) { graphs = info->contextBinaryInfoV1.graphs; graphCount = info->contextBinaryInfoV1.numGraphs; }
        else if (info->version == QNN_SYSTEM_CONTEXT_BINARY_INFO_VERSION_2) { graphs = info->contextBinaryInfoV2.graphs; graphCount = info->contextBinaryInfoV2.numGraphs; }
        else if (info->version == QNN_SYSTEM_CONTEXT_BINARY_INFO_VERSION_3) { graphs = info->contextBinaryInfoV3.graphs; graphCount = info->contextBinaryInfoV3.numGraphs; }
        report << "fullDepthContextBytes=" << binary.size() << " graphCount=" << graphCount << "\n";
        if (!graphs || graphCount != 1) throw std::runtime_error("single full graph required");
        const char* name = nullptr; Qnn_Tensor_t *in = nullptr, *out = nullptr; uint32_t ni = 0, no = 0;
        auto unpack = [&](const auto& g) { name = g.graphName; in = g.graphInputs; out = g.graphOutputs; ni = g.numGraphInputs; no = g.numGraphOutputs; };
        if (graphs[0].version == QNN_SYSTEM_CONTEXT_GRAPH_INFO_VERSION_1) unpack(graphs[0].graphInfoV1);
        else if (graphs[0].version == QNN_SYSTEM_CONTEXT_GRAPH_INFO_VERSION_2) unpack(graphs[0].graphInfoV2);
        else if (graphs[0].version == QNN_SYSTEM_CONTEXT_GRAPH_INFO_VERSION_3) unpack(graphs[0].graphInfoV3);
        if (!name || ni != 1 || no != 1 || !in || !out) throw std::runtime_error("single IO required");
        Qnn_Tensor_t input = *in, output = *out;
        size_t inputBytes = tensorFloats(input) * 4, outputBytes = tensorFloats(output) * 4;
        for (auto pair : {std::make_pair("input", input), std::make_pair("output", output)}) {
            report << "fullDepthTensor=" << pair.first << " version=" << pair.second.version << " float32 dimensions=";
            for (uint32_t i = 0; i < tensorRank(pair.second); ++i) report << tensorDimensions(pair.second)[i] << ",";
            report << "\n";
        }
        status = api.contextCreateFromBinary(backend, device, nullptr, binary.data(), binary.size(), &context, nullptr);
        report << "fullDepthRestore=" << hexError(status) << "\n";
        if (status != QNN_SUCCESS) throw std::runtime_error("context restore");
        Qnn_GraphHandle_t graph = nullptr;
        if (api.graphRetrieve(context, name, &graph) != QNN_SUCCESS) throw std::runtime_error("graph retrieve");
        std::vector<std::vector<uint8_t>> inputs, expected;
        std::vector<float> actual(outputBytes / 4);
        double maximum = 0;
        for (int i = 0; i < 3; ++i) {
            inputs.push_back(depthFile(directory + "/input" + std::to_string(i) + ".f32"));
            expected.push_back(depthFile(directory + "/output" + std::to_string(i) + ".f32"));
            if (inputs.back().size() != inputBytes || expected.back().size() != outputBytes) throw std::runtime_error("reference shape");
            tensorRaw(input, inputs.back().data(), inputBytes); tensorRaw(output, actual.data(), outputBytes);
            status = api.graphExecute(graph, &input, 1, &output, 1, nullptr, nullptr);
            if (status != QNN_SUCCESS) throw std::runtime_error("raw execute");
            for (size_t p = 0; p < actual.size(); ++p) {
                float reference; std::memcpy(&reference, expected.back().data() + p * 4, 4);
                if (!std::isfinite(actual[p]) || !std::isfinite(reference)) throw std::runtime_error("nonfinite depth");
                maximum = std::max(maximum, static_cast<double>(std::abs(actual[p] - reference)));
            }
        }
        if (expected[0] == expected[1] || inputs[0] == inputs[1]) throw std::runtime_error("distinct references required");
        report << "fullDepthRawReferenceMaxAbs=" << maximum << " samples=3\n";
        if (maximum > .000001) throw std::runtime_error("ORT reference mismatch");
        std::vector<double> rawMs;
        for (int i = 0; i < 105; ++i) {
            tensorRaw(input, inputs[i % inputs.size()].data(), inputBytes);
            auto start = std::chrono::steady_clock::now();
            if (api.graphExecute(graph, &input, 1, &output, 1, nullptr, nullptr) != QNN_SUCCESS)
                throw std::runtime_error("raw timing execute");
            if (i >= 5) rawMs.push_back(std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now()-start).count());
        }
        double total = 0; for (double value : rawMs) total += value;
        std::sort(rawMs.begin(), rawMs.end());
        report << "fullDepthRawExecute meanMs=" << total / rawMs.size() << " p95Ms=" << rawMs[94] << "\n";
        report << depthGpu(api, context, graph, input, output, inputs, expected);
        cleanup();
    } catch (const std::exception& e) {
        cleanup(); report << "fullDepthShared=FAIL stage=" << e.what() << "\n";
    }
    return report.str();
}
} // namespace
#else
namespace {
template<class Api>
std::string runFullDepth(const Api&, Qnn_BackendHandle_t, Qnn_DeviceHandle_t, const std::string&, const std::string&) {
    return "fullDepthShared=FAIL stage=matching_sdk_required\n";
}
}
#endif
