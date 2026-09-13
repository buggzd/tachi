#include <jni.h>
#include <android/log.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <dlfcn.h>
#include <cstdint>
#include <limits>
#include <sstream>
#include <string>
#include <vector>

#include "QNN/QnnInterface.h"
#include "QNN/QnnOpDef.h"
#include "QNN/HTP/QnnHtpDevice.h"

namespace {

constexpr char kTag[] = "TachiQnnDirectProbe";
constexpr char kAdspLibraryPath[] =
        "/vendor/lib/rfsa/adsp;/vendor/dsp/cdsp;/vendor/dsp/adsp"
        ";/system/lib/rfsa/adsp;/dsp";
constexpr float kReluQuantScale = 0.05f;
constexpr uint32_t kHtpBackendId = 6;
// QNN scale-offset encoding is real = (quantized + offset) * scale.  The U8
// zero point 128 therefore has an offset of -128 in the QNN struct.
constexpr int32_t kReluQuantOffset = -128;
constexpr std::array<uint8_t, 16> kReluInput = {
        0, 64, 96, 127, 128, 129, 160, 200,
        255, 1, 32, 80, 140, 180, 220, 250};
constexpr std::array<uint8_t, 16> kReluExpected = {
        128, 128, 128, 128, 128, 129, 160, 200,
        255, 128, 128, 128, 140, 180, 220, 250};

uint8_t quantizeReluReference(uint8_t quantizedInput) {
    const float dequantized =
            (static_cast<float>(quantizedInput) + static_cast<float>(kReluQuantOffset))
            * kReluQuantScale;
    const float relu = std::max(0.0f, dequantized);
    const long rounded = std::lround(
            relu / kReluQuantScale - static_cast<float>(kReluQuantOffset));
    const long clamped = std::max<long>(0, std::min<long>(255, rounded));
    return static_cast<uint8_t>(clamped);
}

bool validateReluQuantizationReference(std::string* details) {
    bool matches = true;
    std::ostringstream report;
    report << "quantReference formula=(q+offset)*scale"
           << " scale=" << kReluQuantScale
           << " offset=" << kReluQuantOffset << " dequant=";
    for (uint8_t value : kReluInput) {
        const float dequantized =
                (static_cast<float>(value) + static_cast<float>(kReluQuantOffset))
                * kReluQuantScale;
        report << dequantized << ",";
    }
    report << " relu=";
    for (uint8_t value : kReluInput) {
        const float dequantized =
                (static_cast<float>(value) + static_cast<float>(kReluQuantOffset))
                * kReluQuantScale;
        report << std::max(0.0f, dequantized) << ",";
    }
    report << " requant=";
    for (size_t index = 0; index < kReluInput.size(); ++index) {
        const uint8_t actual = quantizeReluReference(kReluInput[index]);
        report << static_cast<unsigned int>(actual) << ",";
        matches = matches && actual == kReluExpected[index];
    }
    report << " expected=";
    for (uint8_t value : kReluExpected) {
        report << static_cast<unsigned int>(value) << ",";
    }
    report << " result=" << (matches ? "PASS" : "FAIL") << "\n";
    if (details != nullptr) {
        *details = report.str();
    }
    return matches;
}

void logLine(const std::string& line) {
    // Android logcat truncates a single record at roughly 4 KiB.  The probe
    // returns a multi-line report, so emit one record per line to preserve
    // the graph-finalize/execute results on devices with verbose QNN errors.
    size_t start = 0;
    while (start < line.size()) {
        size_t end = line.find('\n', start);
        if (end == std::string::npos) {
            end = line.size();
        }
        __android_log_print(
                ANDROID_LOG_INFO, kTag, "%.*s",
                static_cast<int>(end - start), line.data() + start);
        start = end + (end < line.size() ? 1 : 0);
    }
    if (line.empty()) {
        __android_log_print(ANDROID_LOG_INFO, kTag, "%s", "");
    }
}

std::string hexError(Qnn_ErrorHandle_t error) {
    std::ostringstream stream;
    stream << "0x" << std::hex << static_cast<unsigned long long>(error)
           << "(code=" << std::dec << QNN_GET_ERROR_CODE(error) << ")";
    return stream.str();
}

void* openLibrary(const std::string& directory, const char* name, std::string* error) {
    std::string path = name[0] == '/' ? std::string(name) : directory + "/" + name;
    void* handle = dlopen(path.c_str(), RTLD_NOW | RTLD_GLOBAL);
    if (handle != nullptr) {
        return handle;
    }
    const char* firstError = dlerror();
    handle = dlopen(name, RTLD_NOW | RTLD_GLOBAL);
    if (handle != nullptr) {
        return handle;
    }
    const char* secondError = dlerror();
    if (error != nullptr) {
        *error = std::string(firstError == nullptr ? "" : firstError)
                + " | fallback: "
                + (secondError == nullptr ? "" : secondError);
    }
    return nullptr;
}

struct LoadedLibraries {
    std::vector<void*> handles;

    ~LoadedLibraries() {
        for (auto it = handles.rbegin(); it != handles.rend(); ++it) {
            if (*it != nullptr) {
                dlclose(*it);
            }
        }
    }
};

template <typename InterfaceTable>
std::string describeQnnError(const InterfaceTable& api, Qnn_ErrorHandle_t error) {
    std::ostringstream stream;
    stream << hexError(error);
    if (api.errorGetMessage != nullptr) {
        const char* message = nullptr;
        if (api.errorGetMessage(error, &message) == QNN_SUCCESS && message != nullptr) {
            stream << " message=" << message;
        }
    }
    return stream.str();
}

} // namespace
#include "gpu_shared_probe.h"
namespace {

template <typename InterfaceTable>
std::string runDirectReluGraph(
        const InterfaceTable& api,
        Qnn_BackendHandle_t backend,
        Qnn_DeviceHandle_t device,
        const char* label, bool sharedMemory) {
    std::ostringstream output;
    output << "directGraph=" << label << " begin\n";
    bool chainSuccess = true;
    const char* failedStage = "none";
    if (api.contextCreate == nullptr || api.contextFree == nullptr
            || api.graphCreate == nullptr || api.graphAddNode == nullptr
            || api.graphFinalize == nullptr || api.graphExecute == nullptr
            || api.tensorCreateGraphTensor == nullptr) {
        output << "directProbeStage=apiMissing\n";
        output << "directGraph=" << label << " FAIL\n";
        return output.str();
    }

    Qnn_QuantizeParams_t quantizeParams = QNN_QUANTIZE_PARAMS_INIT;
    quantizeParams.encodingDefinition = QNN_DEFINITION_DEFINED;
    quantizeParams.quantizationEncoding = QNN_QUANTIZATION_ENCODING_SCALE_OFFSET;
    quantizeParams.scaleOffsetEncoding.scale = kReluQuantScale;
    quantizeParams.scaleOffsetEncoding.offset = kReluQuantOffset;
    uint32_t dimensions[] = {1, 1, 1, 16};
    Qnn_Tensor_t input = QNN_TENSOR_INIT;
    input.v1.name = "direct_relu_input";
    input.v1.type = QNN_TENSOR_TYPE_APP_WRITE;
    input.v1.dataFormat = QNN_TENSOR_DATA_FORMAT_FLAT_BUFFER;
    input.v1.dataType = QNN_DATATYPE_UFIXED_POINT_8;
    input.v1.quantizeParams = quantizeParams;
    input.v1.rank = 4;
    input.v1.dimensions = dimensions;
    input.v1.memType = QNN_TENSORMEMTYPE_RAW;
    input.v1.clientBuf.data = nullptr;
    input.v1.clientBuf.dataSize = 0;

    Qnn_Tensor_t outputTensor = QNN_TENSOR_INIT;
    outputTensor.v1.name = "direct_relu_output";
    outputTensor.v1.type = QNN_TENSOR_TYPE_APP_READ;
    outputTensor.v1.dataFormat = QNN_TENSOR_DATA_FORMAT_FLAT_BUFFER;
    outputTensor.v1.dataType = QNN_DATATYPE_UFIXED_POINT_8;
    outputTensor.v1.quantizeParams = quantizeParams;
    outputTensor.v1.rank = 4;
    outputTensor.v1.dimensions = dimensions;
    outputTensor.v1.memType = QNN_TENSORMEMTYPE_RAW;
    outputTensor.v1.clientBuf.data = nullptr;
    outputTensor.v1.clientBuf.dataSize = 0;

    Qnn_ContextHandle_t context = nullptr;
    Qnn_ErrorHandle_t status = api.contextCreate(backend, device, nullptr, &context);
    output << "contextCreate=" << describeQnnError(api, status) << "\n";
    if (status != QNN_SUCCESS || context == nullptr) {
        output << "directProbeStage=contextCreate\n";
        output << "directGraph=" << label << " FAIL\n";
        return output.str();
    }

    Qnn_GraphHandle_t graph = nullptr;
    status = api.graphCreate(context, label, nullptr, &graph);
    output << "graphCreate=" << describeQnnError(api, status) << "\n";
    if (status != QNN_SUCCESS || graph == nullptr) {
        chainSuccess = false;
        failedStage = "graphCreate";
    }
    if (status == QNN_SUCCESS && graph != nullptr) {
        status = api.tensorCreateGraphTensor(graph, &input);
        output << "inputTensor=" << describeQnnError(api, status)
               << " id=" << input.v1.id << "\n";
        if (status != QNN_SUCCESS) {
            chainSuccess = false;
            failedStage = "inputTensor";
        }
        if (status == QNN_SUCCESS) {
            status = api.tensorCreateGraphTensor(graph, &outputTensor);
            output << "outputTensor=" << describeQnnError(api, status)
                   << " id=" << outputTensor.v1.id << "\n";
            if (status != QNN_SUCCESS) {
                chainSuccess = false;
                failedStage = "outputTensor";
            }
        }
    }
    if (status == QNN_SUCCESS && graph != nullptr) {
        Qnn_Tensor_t opInputs[] = {input};
        Qnn_Tensor_t opOutputs[] = {outputTensor};
        Qnn_OpConfig_t op = QNN_OPCONFIG_INIT;
        op.v1.name = "direct_relu_node";
        op.v1.packageName = QNN_OP_PACKAGE_NAME_QTI_AISW;
        op.v1.typeName = QNN_OP_RELU;
        op.v1.numOfInputs = 1;
        op.v1.inputTensors = opInputs;
        op.v1.numOfOutputs = 1;
        op.v1.outputTensors = opOutputs;
        status = api.graphAddNode(graph, op);
        output << "graphAddNode=" << describeQnnError(api, status) << "\n";
        if (status != QNN_SUCCESS) {
            chainSuccess = false;
            failedStage = "graphAddNode";
        }
    }
    if (status == QNN_SUCCESS && graph != nullptr) {
        status = api.graphFinalize(graph, nullptr, nullptr);
        output << "graphFinalize=" << describeQnnError(api, status) << "\n";
        if (status != QNN_SUCCESS) {
            chainSuccess = false;
            failedStage = "graphFinalize";
        }
    }
    bool outputCheck = false;
    if (status == QNN_SUCCESS && graph != nullptr) {
        const uint8_t* inputData = kReluInput.data();
        const uint8_t* expected = kReluExpected.data();
        uint8_t outputData[16] = {};
        Qnn_Tensor_t executeInput = input;
        executeInput.v1.clientBuf.data = const_cast<uint8_t*>(inputData);
        executeInput.v1.clientBuf.dataSize = kReluInput.size();
        Qnn_Tensor_t executeOutput = outputTensor;
        executeOutput.v1.clientBuf.data = outputData;
        executeOutput.v1.clientBuf.dataSize = sizeof(outputData);
        status = api.graphExecute(graph, &executeInput, 1, &executeOutput, 1, nullptr, nullptr);
        output << "graphExecute=" << describeQnnError(api, status) << " output=";
        if (status == QNN_SUCCESS) {
            outputCheck = true;
            for (size_t index = 0; index < 16; ++index) {
                output << static_cast<unsigned int>(outputData[index]) << ",";
                if (outputData[index] != expected[index]) {
                    outputCheck = false;
                }
            }
        }
        output << "\noutputCheck=" << (outputCheck ? "PASS" : "FAIL") << "\n";
        if (status != QNN_SUCCESS) {
            chainSuccess = false;
            failedStage = "graphExecute";
        } else if (!outputCheck) {
            chainSuccess = false;
            failedStage = "outputCheck";
        }
    }
    // Device-only registered-memory experiment, separate from the production depth backend.
    if (sharedMemory && chainSuccess && outputCheck && api.memRegister && api.memDeRegister) {
        using Alloc = void* (*)(int, unsigned int, int);
        using Free = void (*)(void*);
        using ToFd = int (*)(void*);
        void* rpcLibrary = dlopen("libcdsprpc.so", RTLD_NOW | RTLD_LOCAL);
        auto alloc = rpcLibrary ? reinterpret_cast<Alloc>(dlsym(rpcLibrary, "rpcmem_alloc")) : nullptr;
        auto freeMem = rpcLibrary ? reinterpret_cast<Free>(dlsym(rpcLibrary, "rpcmem_free")) : nullptr;
        auto toFd = rpcLibrary ? reinterpret_cast<ToFd>(dlsym(rpcLibrary, "rpcmem_to_fd")) : nullptr;
        output << "sharedMemorySymbols=" << (alloc && freeMem && toFd) << "\n";
        if (alloc && freeMem && toFd) {
            void* blocks[2] = {alloc(25, 1, 4096), alloc(25, 1, 4096)};
            Qnn_MemHandle_t handles[2] = {nullptr, nullptr};
            bool registered = blocks[0] && blocks[1];
            for (int i = 0; i < 2 && registered; ++i) {
                Qnn_MemDescriptor_t desc = QNN_MEM_DESCRIPTOR_INIT;
                desc.memShape.numDim = 4;
                desc.memShape.dimSize = dimensions;
                desc.dataType = QNN_DATATYPE_UFIXED_POINT_8;
                desc.memType = QNN_MEM_TYPE_ION;
                desc.ionInfo.fd = toFd(blocks[i]);
                auto registeredStatus = api.memRegister(context, &desc, 1, &handles[i]);
                output << "sharedRegister[" << i << "]=" << hexError(registeredStatus) << "\n";
                registered = registeredStatus == QNN_SUCCESS;
            }
            bool matched = registered;
            if (registered) {
                Qnn_Tensor_t sharedInput = input, sharedOutput = outputTensor;
                sharedInput.v1.memType = QNN_TENSORMEMTYPE_MEMHANDLE;
                sharedInput.v1.memHandle = handles[0];
                sharedOutput.v1.memType = QNN_TENSORMEMTYPE_MEMHANDLE;
                sharedOutput.v1.memHandle = handles[1];
                // Reuse registered handles across changing inputs: catches stale caches/outputs.
                for (int iteration = 0; iteration < 100 && matched; ++iteration) {
                    auto* in = static_cast<uint8_t*>(blocks[0]);
                    auto* out = static_cast<uint8_t*>(blocks[1]);
                    for (int j = 0; j < 16; ++j) { in[j] = (iteration * 17 + j * 29) & 255; out[j] = 0; }
                    auto executeStatus = api.graphExecute(graph, &sharedInput, 1, &sharedOutput, 1, nullptr, nullptr);
                    matched = executeStatus == QNN_SUCCESS;
                    for (int j = 0; j < 16; ++j) matched = matched && out[j] == std::max<uint8_t>(in[j], 128);
                }
            }
            output << "sharedMemoryRelu100=" << (matched ? "PASS" : "FAIL") << "\n";
            for (int i = 0; i < 2; ++i) {
                if (handles[i]) output << "sharedDeregister[" << i << "]=" << hexError(api.memDeRegister(&handles[i], 1)) << "\n";
                if (blocks[i]) freeMem(blocks[i]);
            }
        }
        if (rpcLibrary) dlclose(rpcLibrary);
    }
    if (sharedMemory && chainSuccess && outputCheck && api.memRegister && api.memDeRegister)
        output << runGpuSharedProbe(api, context, graph, input, outputTensor);
    if (api.contextFree != nullptr) {
        Qnn_ErrorHandle_t freeStatus = api.contextFree(context, nullptr);
        output << "contextFree=" << describeQnnError(api, freeStatus) << "\n";
        if (freeStatus != QNN_SUCCESS && chainSuccess) {
            chainSuccess = false;
            failedStage = "contextFree";
        }
    }
    output << "directProbeStage=" << failedStage << "\n";
    output << "directGraph=" << label << " " << (chainSuccess ? "PASS" : "FAIL")
           << "\n";
    return output.str();
}

std::string runProbe(const std::string& directory, uint32_t socModel, bool sharedMemory) {
    const std::string adspPath = directory + ";" + kAdspLibraryPath;
    setenv("ADSP_LIBRARY_PATH", adspPath.c_str(), 1);

    std::ostringstream output;
    output << "directProbe=begin\n";
    output << "socModel=" << socModel << " signedPdRequested=false\n";
    output << "adspLibraryPath=" << adspPath << "\n";
    std::string quantReference;
    const bool quantReferencePass = validateReluQuantizationReference(&quantReference);
    output << quantReference;
    if (!quantReferencePass) {
        output << "directProbeMarker=FAIL stage=quantReference\n";
        output << "directProbe=end\n";
        return output.str();
    }

    LoadedLibraries libraries;
    // This probe deliberately uses only the application-readable copies.  A
    // production Android deployment must provide the complete, compatible
    // QAIRT set; probing protected vendor paths or linker namespaces would
    // hide that deployment requirement.
    const char* dependencies[] = {
            "/system/lib64/libhidlbase.so",
            "libcdsprpc.so",
            "libQnnHtpV81Stub.so",
            "libQnnHtpV81CalculatorStub.so",
            "libQnnHtpPrepare.so",
            "libQnnHtpNetRunExtensions.so",
            "libQnnHtp.so",
    };
    void* backendLibrary = nullptr;
    for (const char* name : dependencies) {
        std::string error;
        void* handle = openLibrary(directory, name, &error);
        if (handle == nullptr) {
            output << "load=" << name << " failed=" << error << "\n";
            if (std::string(name) == "libQnnHtp.so") {
                output << "directProbeMarker=FAIL stage=loadBackend\n";
                output << "directProbe=end\n";
                return output.str();
            }
            continue;
        }
        libraries.handles.push_back(handle);
        if (std::string(name) == "libQnnHtp.so") {
            backendLibrary = handle;
        }
        output << "load=" << name << " ok\n";
    }

    if (backendLibrary == nullptr) {
        output << "directProbeMarker=FAIL stage=loadBackend\n";
        output << "directProbe=end\n";
        return output.str();
    }

    using GetProvidersFn = Qnn_ErrorHandle_t (*)(const QnnInterface_t***, uint32_t*);
    auto getProviders = reinterpret_cast<GetProvidersFn>(
            dlsym(backendLibrary, "QnnInterface_getProviders"));
    if (getProviders == nullptr) {
        output << "providers=missing error=" << (dlerror() == nullptr ? "unknown" : dlerror()) << "\n";
        output << "directProbeMarker=FAIL stage=providers\n";
        output << "directProbe=end\n";
        return output.str();
    }

    const QnnInterface_t** providers = nullptr;
    uint32_t providerCount = 0;
    Qnn_ErrorHandle_t status = getProviders(&providers, &providerCount);
    output << "providersStatus=" << hexError(status)
           << " count=" << providerCount << "\n";
    if (status != QNN_SUCCESS || providers == nullptr || providerCount == 0) {
        output << "directProbeMarker=FAIL stage=providers\n";
        output << "directProbe=end\n";
        return output.str();
    }

    const QnnInterface_t* provider = nullptr;
    for (uint32_t index = 0; index < providerCount; ++index) {
        if (providers[index] == nullptr) {
            output << "provider[" << index << "]=" << "null\n";
            continue;
        }
        const QnnInterface_t* candidate = providers[index];
        output << "provider[" << index << "] backendId=" << candidate->backendId
               << " name=" << (candidate->providerName == nullptr ? "" : candidate->providerName)
               << " api=" << candidate->apiVersion.coreApiVersion.major << "."
               << candidate->apiVersion.coreApiVersion.minor << "."
               << candidate->apiVersion.coreApiVersion.patch << "\n";
        if (candidate->backendId == kHtpBackendId && provider == nullptr) {
            provider = candidate;
        }
    }
    if (provider == nullptr) {
        output << "providerSelection=FAIL requiredBackendId=" << kHtpBackendId << "\n";
        output << "directProbeMarker=FAIL stage=providerSelection\n";
        output << "directProbe=end\n";
        return output.str();
    }
    output << "providerSelection=PASS backendId=" << provider->backendId
           << " name=" << (provider->providerName == nullptr ? "" : provider->providerName)
           << "\n";
    const Qnn_ApiVersion_t providerApi = provider->apiVersion;
    output << "providerApi=" << providerApi.coreApiVersion.major << "."
           << providerApi.coreApiVersion.minor << "."
           << providerApi.coreApiVersion.patch << "\n";
    output << "probeHeaderApi=" << QNN_API_VERSION_MAJOR << "."
           << QNN_API_VERSION_MINOR << "." << QNN_API_VERSION_PATCH << "\n";
    // The union member below is named from the compile-time header version.
    // Do not call it unless the provider advertises the same major/minor ABI.
    if (providerApi.coreApiVersion.major != QNN_API_VERSION_MAJOR
            || providerApi.coreApiVersion.minor != QNN_API_VERSION_MINOR) {
        output << "apiCompatibility=FAIL required=" << QNN_API_VERSION_MAJOR << "."
               << QNN_API_VERSION_MINOR << " actual=" << providerApi.coreApiVersion.major
               << "." << providerApi.coreApiVersion.minor << "\n";
        output << "directProbeMarker=FAIL stage=apiCompatibility\n";
        output << "directProbe=end\n";
        return output.str();
    }
    output << "apiCompatibility=PASS majorMinorMatch=true\n";
    const auto& interfaceTable = provider->QNN_INTERFACE_VER_NAME;
    if (interfaceTable.backendCreate == nullptr || interfaceTable.deviceCreate == nullptr) {
        output << "interface=missing backendCreateOrDeviceCreate\n";
        output << "directProbeMarker=FAIL stage=interface\n";
        output << "directProbe=end\n";
        return output.str();
    }

    Qnn_BackendHandle_t backend = nullptr;
    status = interfaceTable.backendCreate(nullptr, nullptr, &backend);
    output << "backendCreate=" << hexError(status) << "\n";
    if (status != QNN_SUCCESS || backend == nullptr) {
        output << "directProbeMarker=FAIL stage=backendCreate\n";
        output << "directProbe=end\n";
        return output.str();
    }

    const char* buildId = nullptr;
    if (interfaceTable.backendGetBuildId != nullptr
            && interfaceTable.backendGetBuildId(&buildId) == QNN_SUCCESS
            && buildId != nullptr) {
        output << "backendBuildId=" << buildId << "\n";
    }
    if (interfaceTable.backendGetApiVersion != nullptr) {
        Qnn_ApiVersion_t backendApi{};
        Qnn_ErrorHandle_t apiStatus = interfaceTable.backendGetApiVersion(&backendApi);
        output << "backendApiStatus=" << hexError(apiStatus)
               << " api=" << backendApi.coreApiVersion.major << "."
               << backendApi.coreApiVersion.minor << "."
               << backendApi.coreApiVersion.patch << "\n";
    }

    QnnHtpDevice_CustomConfig_t socConfig{};
    socConfig.option = QNN_HTP_DEVICE_CONFIG_OPTION_SOC;
    socConfig.socModel = socModel;
    QnnHtpDevice_CustomConfig_t signedPdConfig{};
    signedPdConfig.option = QNN_HTP_DEVICE_CONFIG_OPTION_SIGNEDPD;
    signedPdConfig.useSignedProcessDomain.deviceId = 0;
    signedPdConfig.useSignedProcessDomain.useSignedProcessDomain = false;
    QnnDevice_Config_t socDeviceConfig{};
    socDeviceConfig.option = QNN_DEVICE_CONFIG_OPTION_CUSTOM;
    socDeviceConfig.customConfig = &socConfig;
    QnnDevice_Config_t signedPdDeviceConfig{};
    signedPdDeviceConfig.option = QNN_DEVICE_CONFIG_OPTION_CUSTOM;
    signedPdDeviceConfig.customConfig = &signedPdConfig;
    const QnnDevice_Config_t* configList[] = {
            &socDeviceConfig, &signedPdDeviceConfig, nullptr};
    Qnn_DeviceHandle_t device = nullptr;
    Qnn_ErrorHandle_t deviceStatus = interfaceTable.deviceCreate(
            nullptr, configList, &device);
    output << "deviceCreate[soc+signedpd]=" << hexError(deviceStatus) << "\n";
    bool chainPass = deviceStatus == QNN_SUCCESS && device != nullptr;
    if (chainPass) {
        output << "deviceCreateSuccess=soc+signedpd\n";
        const std::string graphResult = runDirectReluGraph(
                interfaceTable, backend, device, "relu_u8", sharedMemory);
        output << graphResult;
        chainPass = graphResult.find("directGraph=relu_u8 PASS") != std::string::npos;
        if (interfaceTable.deviceFree != nullptr) {
            Qnn_ErrorHandle_t freeStatus = interfaceTable.deviceFree(device);
            output << "deviceFree=" << hexError(freeStatus) << "\n";
        }
    } else {
        output << "directProbeMarker=FAIL stage=deviceCreate\n";
    }

    if (interfaceTable.backendFree != nullptr) {
        output << "backendFree=" << hexError(interfaceTable.backendFree(backend)) << "\n";
    }
    output << "deviceCreateResult="
           << (deviceStatus == QNN_SUCCESS && device != nullptr ? "PASS" : "FAIL") << "\n";
    output << "minimalChain=" << (chainPass ? "PASS" : "FAIL") << "\n";
    if (chainPass) {
        output << "directProbeMarker=PASS\n";
    } else if (deviceStatus == QNN_SUCCESS) {
        output << "directProbeMarker=FAIL stage=graph\n";
    }
    output << "directProbe=end\n";
    return output.str();
}

}  // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_com_tachi_stereolab_npubenchmark_MainActivity_nativeProbeQnn(
        JNIEnv* environment, jobject, jstring backendDirectory, jint socModel, jboolean sharedMemory) {
    if (backendDirectory == nullptr) {
        return environment->NewStringUTF("directProbe=invalidBackendDirectory\n");
    }
    const char* chars = environment->GetStringUTFChars(backendDirectory, nullptr);
    std::string directory = chars == nullptr ? "" : chars;
    if (chars != nullptr) {
        environment->ReleaseStringUTFChars(backendDirectory, chars);
    }
    std::string result = runProbe(directory, static_cast<uint32_t>(socModel), sharedMemory == JNI_TRUE);
    logLine(result);
    return environment->NewStringUTF(result.c_str());
}
