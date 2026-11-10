// MD Notepad - Notepad++ plugin.
// Docks a WebView2 panel with a live preview of the current document. The preview page
// (web/) renders Markdown with marked, DOMPurify and Mermaid.
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <commdlg.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <wrl.h>

#include <stdarg.h>
#include <functional>
#include <string>
#include <utility>

#include "WebView2.h"
#include "npp_api.h"

using Microsoft::WRL::ComPtr;

namespace {

const wchar_t* const kPluginName = L"MD Notepad";
const wchar_t* const kPanelTitle = L"MD Preview";
const wchar_t* const kPanelClass = L"MdNotepadPanel";
const wchar_t* const kAppHost = L"mdnotepad.plugin";
const wchar_t* const kAppUrlPrefix = L"https://mdnotepad.plugin/";
const UINT_PTR kUpdateTimer = 1;
const UINT kUpdateDelayMs = 120;
const int IDI_TOOLBAR = 101;  // resources/mdnotepad.rc

enum Command { CMD_TOGGLE, CMD_SYNC, CMD_DARK, CMD_SEPARATOR, CMD_PDF, CMD_ABOUT, CMD_COUNT };

HINSTANCE g_hInst = nullptr;
NppData g_npp = {};
FuncItem g_funcs[CMD_COUNT] = {};
ShortcutKey g_toggleKey = {true, true, true, 'M'};
tTbData g_tb = {};

HWND g_panel = nullptr;
bool g_dockRegistered = false;
bool g_visible = false;        // the panel is open (user intent)
bool g_syncScroll = true;
bool g_dark = false;
bool g_initStarted = false;
bool g_pageReady = false;
bool g_logEnabled = false;
int g_lastPpm = -1;

std::wstring g_webDir;
std::wstring g_iniPath;
std::wstring g_moduleName;
std::wstring g_docDir;
std::wstring g_docName;
std::wstring g_pdfPath;

ComPtr<ICoreWebView2Environment> g_env;
ComPtr<ICoreWebView2Controller> g_controller;
ComPtr<ICoreWebView2> g_view;

// ---------------------------------------------------------------- helpers

void Log(const wchar_t* fmt, ...) {
    if (!g_logEnabled) {
        return;
    }
    wchar_t text[1024];
    va_list args;
    va_start(args, fmt);
    _vsnwprintf_s(text, _countof(text), _TRUNCATE, fmt, args);
    va_end(args);

    wchar_t path[MAX_PATH];
    if (!GetTempPathW(MAX_PATH, path)) {
        return;
    }
    wcscat_s(path, L"mdnotepad.log");
    HANDLE file = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                              OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return;
    }
    std::wstring line = text;
    line += L"\r\n";
    int n = WideCharToMultiByte(CP_UTF8, 0, line.c_str(), (int)line.size(), nullptr, 0, nullptr, nullptr);
    std::string utf8(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, line.c_str(), (int)line.size(), &utf8[0], n, nullptr, nullptr);
    DWORD written = 0;
    WriteFile(file, utf8.data(), (DWORD)utf8.size(), &written, nullptr);
    CloseHandle(file);
}

LRESULT NppSend(UINT msg, WPARAM wParam = 0, LPARAM lParam = 0) {
    return SendMessageW(g_npp._nppHandle, msg, wParam, lParam);
}

void SetMenuCheck(Command command, bool checked) {
    NppSend(NPPM_SETMENUITEMCHECK, (WPARAM)g_funcs[command]._cmdID, checked ? TRUE : FALSE);
}

HWND CurrentScintilla() {
    int which = 0;
    NppSend(NPPM_GETCURRENTSCINTILLA, 0, (LPARAM)&which);
    return which == 1 ? g_npp._scintillaSecondHandle : g_npp._scintillaMainHandle;
}

std::wstring GetEnv(const wchar_t* name) {
    wchar_t buffer[MAX_PATH * 2];
    DWORD n = GetEnvironmentVariableW(name, buffer, _countof(buffer));
    if (n == 0 || n >= _countof(buffer)) {
        return L"";
    }
    return std::wstring(buffer, n);
}

void LoadSettings() {
    g_syncScroll = GetPrivateProfileIntW(L"Preview", L"SyncScroll", 1, g_iniPath.c_str()) != 0;
    g_dark = GetPrivateProfileIntW(L"Preview", L"Dark", 0, g_iniPath.c_str()) != 0;
    g_visible = GetPrivateProfileIntW(L"Preview", L"Visible", 0, g_iniPath.c_str()) != 0;
}

void SaveSettings() {
    WritePrivateProfileStringW(L"Preview", L"SyncScroll", g_syncScroll ? L"1" : L"0", g_iniPath.c_str());
    WritePrivateProfileStringW(L"Preview", L"Dark", g_dark ? L"1" : L"0", g_iniPath.c_str());
    WritePrivateProfileStringW(L"Preview", L"Visible", g_visible ? L"1" : L"0", g_iniPath.c_str());
}

bool IsSafeExternalUrl(const std::wstring& url) {
    auto starts = [&](const wchar_t* prefix) { return _wcsnicmp(url.c_str(), prefix, wcslen(prefix)) == 0; };
    return starts(L"http://") || starts(L"https://") || starts(L"mailto:");
}

void OpenExternal(const std::wstring& url) {
    if (IsSafeExternalUrl(url)) {
        ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    }
}

// ---------------------------------------------------------------- minimal COM callbacks

template <class Iface>
class Unknown : public Iface {
public:
    virtual ~Unknown() {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (riid == __uuidof(IUnknown) || riid == __uuidof(Iface)) {
            *ppv = static_cast<Iface*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return (ULONG)InterlockedIncrement(&ref_); }
    ULONG STDMETHODCALLTYPE Release() override {
        LONG r = InterlockedDecrement(&ref_);
        if (r == 0) {
            delete this;
        }
        return (ULONG)r;
    }

private:
    LONG ref_ = 1;
};

template <class Iface, class Fn, class... A>
class CallbackImpl : public Unknown<Iface> {
public:
    explicit CallbackImpl(Fn fn) : fn_(std::move(fn)) {}
    HRESULT STDMETHODCALLTYPE Invoke(A... args) override {
        fn_(args...);
        return S_OK;
    }

private:
    Fn fn_;
};

// Returns a callback with one reference, owned by the caller.
template <class Iface, class... A, class Fn>
Iface* MakeCallback(Fn fn) {
    return new CallbackImpl<Iface, Fn, A...>(std::move(fn));
}

// ---------------------------------------------------------------- talking to the page

void PostJson(const std::wstring& json) {
    if (g_view) {
        g_view->PostWebMessageAsJson(json.c_str());
    }
}

std::wstring Utf8OrAnsiToWide(const std::string& bytes, UINT codePage) {
    if (bytes.empty()) {
        return L"";
    }
    int n = MultiByteToWideChar(codePage, 0, bytes.data(), (int)bytes.size(), nullptr, 0);
    if (n <= 0) {
        return L"";
    }
    std::wstring wide(n, L'\0');
    MultiByteToWideChar(codePage, 0, bytes.data(), (int)bytes.size(), &wide[0], n);
    return wide;
}

void UpdateDocumentFolder() {
    wchar_t path[MAX_PATH * 4] = {};
    NppSend(NPPM_GETFULLCURRENTPATH, _countof(path), (LPARAM)path);

    std::wstring dir;
    std::wstring name;
    const wchar_t* slash = wcsrchr(path, L'\\');
    if (slash) {
        dir.assign(path, slash - path);
        name = slash + 1;
        if (!PathIsDirectoryW(dir.c_str())) {
            dir.clear();
        }
    }
    g_docName = name;

    if (dir == g_docDir) {
        return;
    }
    g_docDir = dir;

    // Relative images are loaded through the per-drive virtual hosts created in OnControllerCreated:
    // the page builds https://<drive>.mdnotepad.plugin/<folder>/<image>. UNC folders have no drive host.
    std::wstring drive;
    std::wstring folder;
    if (dir.size() >= 2 && dir[1] == L':' && iswalpha(dir[0])) {
        drive = std::wstring(1, (wchar_t)towlower(dir[0]));
        for (size_t i = 2; i < dir.size(); ++i) {
            wchar_t c = dir[i];
            if (c == L'\\' || c == L'/') {
                folder += L'/';
            } else if (c == L'"') {
                folder += L"\\\"";
            } else {
                folder += c;
            }
        }
    }
    PostJson(L"{\"type\":\"doc\",\"drive\":\"" + drive + L"\",\"dir\":\"" + folder + L"\"}");
}

void SendScroll(bool force) {
    if (!g_syncScroll || !g_pageReady || !g_view) {
        return;
    }
    HWND sci = CurrentScintilla();
    LRESULT first = SendMessageW(sci, SCI_GETFIRSTVISIBLELINE, 0, 0);
    LRESULT lines = SendMessageW(sci, SCI_GETLINECOUNT, 0, 0);
    LRESULT onScreen = SendMessageW(sci, SCI_LINESONSCREEN, 0, 0);
    LRESULT total = SendMessageW(sci, SCI_VISIBLEFROMDOCLINE, (WPARAM)lines, 0);
    bool endAtLastLine = SendMessageW(sci, SCI_GETENDATLASTLINE, 0, 0) != 0;

    LRESULT maxFirst = total - (endAtLastLine ? onScreen : 1);
    double ratio = maxFirst > 0 ? (double)first / (double)maxFirst : 0.0;
    if (ratio < 0.0) ratio = 0.0;
    if (ratio > 1.0) ratio = 1.0;
    int ppm = (int)(ratio * 1000000.0);
    if (!force && ppm == g_lastPpm) {
        return;
    }
    g_lastPpm = ppm;
    Log(L"scroll: first=%d lines=%d onScreen=%d total=%d endAtLast=%d -> ppm=%d", (int)first, (int)lines,
        (int)onScreen, (int)total, endAtLastLine ? 1 : 0, ppm);
    PostJson(L"{\"type\":\"scroll\",\"ppm\":" + std::to_wstring(ppm) + L"}");
}

void SendDocument() {
    if (!g_pageReady || !g_view) {
        return;
    }
    UpdateDocumentFolder();

    HWND sci = CurrentScintilla();
    LRESULT length = SendMessageW(sci, SCI_GETLENGTH, 0, 0);
    std::string bytes((size_t)length + 1, '\0');
    SendMessageW(sci, SCI_GETTEXT, (WPARAM)length + 1, (LPARAM)&bytes[0]);
    bytes.resize((size_t)length);

    UINT codePage = (UINT)SendMessageW(sci, SCI_GETCODEPAGE, 0, 0);
    std::wstring text = Utf8OrAnsiToWide(bytes, codePage == 0 ? CP_ACP : codePage);
    g_view->PostWebMessageAsString(text.c_str());
    SendScroll(true);
}

void ScheduleUpdate() {
    if (g_panel) {
        SetTimer(g_panel, kUpdateTimer, kUpdateDelayMs, nullptr);
    }
}

void SendSettings() {
    PostJson(std::wstring(L"{\"type\":\"settings\",\"dark\":") + (g_dark ? L"true" : L"false") + L"}");
}

// ---------------------------------------------------------------- PDF export

void ExportPdfNow() {
    ComPtr<ICoreWebView2_7> view7;
    ComPtr<ICoreWebView2Environment6> env6;
    if (!g_view || !g_env || FAILED(g_view.As(&view7)) || FAILED(g_env.As(&env6))) {
        MessageBoxW(g_npp._nppHandle, L"PDF export is not available in this WebView2 runtime.", kPluginName,
                    MB_OK | MB_ICONWARNING);
        return;
    }
    ComPtr<ICoreWebView2PrintSettings> settings;
    if (SUCCEEDED(env6->CreatePrintSettings(&settings)) && settings) {
        settings->put_ShouldPrintHeaderAndFooter(FALSE);
        settings->put_PageWidth(8.27);
        settings->put_PageHeight(11.69);
        settings->put_MarginTop(0.4);
        settings->put_MarginBottom(0.4);
        settings->put_MarginLeft(0.4);
        settings->put_MarginRight(0.4);
    }
    auto* done = MakeCallback<ICoreWebView2PrintToPdfCompletedHandler, HRESULT, BOOL>(
        [](HRESULT hr, BOOL ok) {
            PostJson(L"{\"type\":\"restore-theme\"}");
            if (FAILED(hr) || !ok) {
                MessageBoxW(g_npp._nppHandle, L"Could not save the PDF file.", kPluginName, MB_OK | MB_ICONERROR);
            } else {
                MessageBoxW(g_npp._nppHandle, (L"PDF saved:\n" + g_pdfPath).c_str(), kPluginName,
                            MB_OK | MB_ICONINFORMATION);
            }
        });
    HRESULT hr = view7->PrintToPdf(g_pdfPath.c_str(), settings.Get(), done);
    done->Release();
    if (FAILED(hr)) {
        PostJson(L"{\"type\":\"restore-theme\"}");
        MessageBoxW(g_npp._nppHandle, L"Could not start the PDF export.", kPluginName, MB_OK | MB_ICONERROR);
    }
}

// ---------------------------------------------------------------- WebView2

void ResizeWebView() {
    if (g_controller && g_panel) {
        RECT rc;
        GetClientRect(g_panel, &rc);
        g_controller->put_Bounds(rc);
    }
}

void ReportInitError(HRESULT hr) {
    wchar_t text[512];
    swprintf_s(text,
               L"Cannot start the preview (WebView2 error 0x%08X).\n\n"
               L"The Microsoft Edge WebView2 Runtime is required. It is preinstalled on Windows 11; "
               L"on older systems install it from https://developer.microsoft.com/microsoft-edge/webview2/",
               (unsigned)hr);
    MessageBoxW(g_npp._nppHandle, text, kPluginName, MB_OK | MB_ICONERROR);
}

void HandlePageMessage(const std::wstring& message) {
    Log(L"page message: %.300s", message.c_str());
    Log(L"doc dir=%s", g_docDir.c_str());
    if (message == L"ready") {
        g_pageReady = true;
        g_lastPpm = -1;
        g_docDir.clear();
        SendSettings();
        SendDocument();
    } else if (message == L"print-ready") {
        ExportPdfNow();
    } else if (message.compare(0, 5, L"open:") == 0) {
        OpenExternal(message.substr(5));
    }
}

void OnControllerCreated(ICoreWebView2Controller* controller) {
    g_controller = controller;
    g_controller->get_CoreWebView2(&g_view);
    if (!g_view) {
        return;
    }

    ComPtr<ICoreWebView2Settings> settings;
    if (SUCCEEDED(g_view->get_Settings(&settings)) && settings) {
        settings->put_IsStatusBarEnabled(FALSE);
    }
    ComPtr<ICoreWebView2Controller2> controller2;
    if (SUCCEEDED(g_controller.As(&controller2))) {
        COREWEBVIEW2_COLOR color = g_dark ? COREWEBVIEW2_COLOR{255, 0x21, 0x28, 0x30}
                                          : COREWEBVIEW2_COLOR{255, 255, 255, 255};
        controller2->put_DefaultBackgroundColor(color);
    }
    ResizeWebView();
    g_controller->put_IsVisible(IsWindowVisible(g_panel) ? TRUE : FALSE);

    ComPtr<ICoreWebView2_3> view3;
    if (SUCCEEDED(g_view.As(&view3))) {
        view3->SetVirtualHostNameToFolderMapping(kAppHost, g_webDir.c_str(),
                                                 COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);

        // One virtual host per drive ("c.mdnotepad.plugin" -> "C:\") so that relative image paths of the
        // open document resolve. The page's CSP only lets them be used as images.
        DWORD drives = GetLogicalDrives();
        for (int i = 0; i < 26; ++i) {
            if (!(drives & (1u << i))) {
                continue;
            }
            wchar_t root[] = {(wchar_t)(L'A' + i), L':', L'\\', 0};
            if (GetDriveTypeW(root) == DRIVE_CDROM) {
                continue;
            }
            std::wstring host = std::wstring(1, (wchar_t)(L'a' + i)) + L".mdnotepad.plugin";
            HRESULT mapped = view3->SetVirtualHostNameToFolderMapping(
                host.c_str(), root, COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);
            Log(L"map %s -> %s: 0x%08X", host.c_str(), root, (unsigned)mapped);
        }
    }

    EventRegistrationToken token;
    auto* onMessage = MakeCallback<ICoreWebView2WebMessageReceivedEventHandler, ICoreWebView2*,
                                   ICoreWebView2WebMessageReceivedEventArgs*>(
        [](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) {
            LPWSTR text = nullptr;
            if (SUCCEEDED(args->TryGetWebMessageAsString(&text)) && text) {
                std::wstring message = text;
                CoTaskMemFree(text);
                HandlePageMessage(message);
            }
        });
    g_view->add_WebMessageReceived(onMessage, &token);
    onMessage->Release();

    // Only the plugin's own page may be shown; everything else opens in the default browser.
    auto* onNavigate = MakeCallback<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2*,
                                    ICoreWebView2NavigationStartingEventArgs*>(
        [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) {
            LPWSTR uri = nullptr;
            if (SUCCEEDED(args->get_Uri(&uri)) && uri) {
                if (wcsncmp(uri, kAppUrlPrefix, wcslen(kAppUrlPrefix)) != 0) {
                    args->put_Cancel(TRUE);
                }
                CoTaskMemFree(uri);
            }
        });
    g_view->add_NavigationStarting(onNavigate, &token);
    onNavigate->Release();

    auto* onNewWindow = MakeCallback<ICoreWebView2NewWindowRequestedEventHandler, ICoreWebView2*,
                                     ICoreWebView2NewWindowRequestedEventArgs*>(
        [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) {
            args->put_Handled(TRUE);
            LPWSTR uri = nullptr;
            if (SUCCEEDED(args->get_Uri(&uri)) && uri) {
                OpenExternal(uri);
                CoTaskMemFree(uri);
            }
        });
    g_view->add_NewWindowRequested(onNewWindow, &token);
    onNewWindow->Release();

    g_pageReady = false;
    g_view->Navigate((std::wstring(kAppUrlPrefix) + L"index.html").c_str());
}

void EnsureWebView() {
    if (g_initStarted) {
        return;
    }
    g_initStarted = true;
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    std::wstring dataDir = GetEnv(L"LOCALAPPDATA");
    if (dataDir.empty()) {
        dataDir = GetEnv(L"TEMP");
    }
    dataDir += L"\\mdnotepad\\WebView2";
    SHCreateDirectoryExW(nullptr, dataDir.c_str(), nullptr);

    auto* onEnvironment = MakeCallback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler, HRESULT,
                                       ICoreWebView2Environment*>([](HRESULT hr, ICoreWebView2Environment* env) {
        Log(L"environment created: 0x%08X", (unsigned)hr);
        if (FAILED(hr) || !env) {
            ReportInitError(hr);
            return;
        }
        g_env = env;
        auto* onController = MakeCallback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, HRESULT,
                                          ICoreWebView2Controller*>([](HRESULT hr2, ICoreWebView2Controller* controller) {
            Log(L"controller created: 0x%08X", (unsigned)hr2);
            if (FAILED(hr2) || !controller) {
                ReportInitError(hr2);
                return;
            }
            OnControllerCreated(controller);
        });
        HRESULT hr3 = env->CreateCoreWebView2Controller(g_panel, onController);
        onController->Release();
        if (FAILED(hr3)) {
            ReportInitError(hr3);
        }
    });
    HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, dataDir.c_str(), nullptr, onEnvironment);
    onEnvironment->Release();
    Log(L"CreateCoreWebView2EnvironmentWithOptions: 0x%08X", (unsigned)hr);
    if (FAILED(hr)) {
        ReportInitError(hr);
    }
}

void ShutdownWebView() {
    if (g_panel) {
        KillTimer(g_panel, kUpdateTimer);
    }
    g_pageReady = false;
    if (g_controller) {
        g_controller->Close();
    }
    g_view.Reset();
    g_controller.Reset();
    g_env.Reset();
}

// ---------------------------------------------------------------- panel window

LRESULT CALLBACK PanelProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
        case WM_SIZE:
            ResizeWebView();
            return 0;
        case WM_SHOWWINDOW:
            if (g_controller) {
                g_controller->put_IsVisible(wParam ? TRUE : FALSE);
            }
            return 0;
        case WM_ERASEBKGND:
            return 1;
        case WM_SETFOCUS:
            if (g_controller) {
                g_controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
            }
            return 0;
        case WM_TIMER:
            if (wParam == kUpdateTimer) {
                KillTimer(hwnd, kUpdateTimer);
                SendDocument();
            }
            return 0;
        case WM_NOTIFY: {
            const NMHDR* header = reinterpret_cast<const NMHDR*>(lParam);
            if (header && header->hwndFrom == g_npp._nppHandle && LOWORD(header->code) == DMN_CLOSE) {
                g_visible = false;
                SetMenuCheck(CMD_TOGGLE, false);
                SaveSettings();
            }
            return 0;
        }
        default:
            return DefWindowProcW(hwnd, message, wParam, lParam);
    }
}

void EnsurePanel() {
    if (g_panel) {
        return;
    }
    WNDCLASSW wc = {};
    wc.lpfnWndProc = PanelProc;
    wc.hInstance = g_hInst;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.lpszClassName = kPanelClass;
    RegisterClassW(&wc);
    g_panel = CreateWindowExW(0, kPanelClass, L"", WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS, 0, 0, 300, 400,
                              g_npp._nppHandle, nullptr, g_hInst, nullptr);
}

void ShowPanel() {
    EnsurePanel();
    if (!g_panel) {
        return;
    }
    if (!g_dockRegistered) {
        g_tb = {};
        g_tb.hClient = g_panel;
        g_tb.pszName = kPanelTitle;
        g_tb.dlgID = CMD_TOGGLE;
        g_tb.uMask = DWS_DF_CONT_RIGHT;
        g_tb.pszModuleName = g_moduleName.c_str();
        NppSend(NPPM_DMMREGASDCKDLG, 0, (LPARAM)&g_tb);
        g_dockRegistered = true;
    }
    NppSend(NPPM_DMMSHOW, 0, (LPARAM)g_panel);
    g_visible = true;
    SetMenuCheck(CMD_TOGGLE, true);
    EnsureWebView();
    ScheduleUpdate();
    SaveSettings();
}

void HidePanel() {
    if (g_panel) {
        NppSend(NPPM_DMMHIDE, 0, (LPARAM)g_panel);
    }
    g_visible = false;
    SetMenuCheck(CMD_TOGGLE, false);
    SaveSettings();
}

// ---------------------------------------------------------------- menu commands

void CmdToggle() {
    Log(L"toggle command (open=%d)", g_visible ? 1 : 0);
    if (g_visible) {
        HidePanel();
    } else {
        ShowPanel();
    }
}

void CmdSyncScroll() {
    g_syncScroll = !g_syncScroll;
    SetMenuCheck(CMD_SYNC, g_syncScroll);
    SaveSettings();
    if (g_syncScroll) {
        SendScroll(true);
    }
}

void CmdDark() {
    g_dark = !g_dark;
    SetMenuCheck(CMD_DARK, g_dark);
    SaveSettings();
    if (g_controller) {
        ComPtr<ICoreWebView2Controller2> controller2;
        if (SUCCEEDED(g_controller.As(&controller2))) {
            COREWEBVIEW2_COLOR color = g_dark ? COREWEBVIEW2_COLOR{255, 0x21, 0x28, 0x30}
                                              : COREWEBVIEW2_COLOR{255, 255, 255, 255};
            controller2->put_DefaultBackgroundColor(color);
        }
    }
    SendSettings();
}

void CmdExportPdf() {
    if (!g_visible) {
        ShowPanel();
    }
    if (!g_pageReady) {
        MessageBoxW(g_npp._nppHandle, L"The preview is still loading. Try again in a moment.", kPluginName,
                    MB_OK | MB_ICONINFORMATION);
        return;
    }
    wchar_t file[MAX_PATH] = {};
    std::wstring suggested = g_docName.empty() ? L"preview" : g_docName;
    size_t dot = suggested.find_last_of(L'.');
    if (dot != std::wstring::npos && dot > 0) {
        suggested.resize(dot);
    }
    wcsncpy_s(file, suggested.c_str(), _TRUNCATE);
    wcscat_s(file, L".pdf");

    OPENFILENAMEW ofn = {};
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = g_npp._nppHandle;
    ofn.lpstrFilter = L"PDF (*.pdf)\0*.pdf\0";
    ofn.lpstrFile = file;
    ofn.nMaxFile = MAX_PATH;
    ofn.lpstrDefExt = L"pdf";
    ofn.lpstrInitialDir = g_docDir.empty() ? nullptr : g_docDir.c_str();
    ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    if (!GetSaveFileNameW(&ofn)) {
        return;
    }
    g_pdfPath = file;
    // The page switches to the light theme and re-renders diagrams, then answers "print-ready".
    PostJson(L"{\"type\":\"prepare-print\"}");
}

void CmdAbout() {
    MessageBoxW(g_npp._nppHandle,
                L"MD Notepad - Markdown live preview for Notepad++\n\n"
                L"Live preview of the current document in a docked panel.\n"
                L"Rendering: marked, DOMPurify, Mermaid, GitHub Markdown CSS.\n"
                L"Panel engine: Microsoft Edge WebView2.",
                kPluginName, MB_OK | MB_ICONINFORMATION);
}

// Adds the "mn" button to the Notepad++ toolbar; it runs the "Show/hide preview panel" command.
void AddToolbarButton() {
    UINT dpi = 96;
    using GetDpiForWindowFn = UINT(WINAPI*)(HWND);
    auto getDpi = reinterpret_cast<GetDpiForWindowFn>(
        GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow"));
    if (getDpi) {
        dpi = getDpi(g_npp._nppHandle);
    }
    int size = MulDiv(16, (int)dpi, 96);
    HICON icon = (HICON)LoadImageW(g_hInst, MAKEINTRESOURCEW(IDI_TOOLBAR), IMAGE_ICON, size, size, LR_DEFAULTCOLOR);
    if (!icon) {
        Log(L"toolbar icon not loaded: %u", GetLastError());
        return;
    }
    HBITMAP bitmap = nullptr;
    ICONINFO info = {};
    if (GetIconInfo(icon, &info)) {
        bitmap = info.hbmColor;
        if (info.hbmMask) {
            DeleteObject(info.hbmMask);
        }
    }
    // Notepad++ keeps using these handles, so they live until the process ends.
    static toolbarIconsWithDarkMode icons;
    icons = {bitmap, icon, icon};
    NppSend(NPPM_ADDTOOLBARICON_FORDARKMODE, (WPARAM)g_funcs[CMD_TOGGLE]._cmdID, (LPARAM)&icons);
    Log(L"toolbar button added (size %d, cmd %d)", size, g_funcs[CMD_TOGGLE]._cmdID);
}

void InitFuncItem(Command command, const wchar_t* name, PFUNCPLUGINCMD func, bool checked, ShortcutKey* key) {
    FuncItem& item = g_funcs[command];
    wcsncpy_s(item._itemName, name, _TRUNCATE);
    item._pFunc = func;
    item._init2Check = checked;
    item._pShKey = key;
}

}  // namespace

// ---------------------------------------------------------------- plugin interface

extern "C" {

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_hInst = module;
        DisableThreadLibraryCalls(module);
    }
    return TRUE;
}

__declspec(dllexport) void setInfo(NppData data) {
    g_npp = data;
    g_logEnabled = !GetEnv(L"MDNOTEPAD_LOG").empty();

    wchar_t modulePath[MAX_PATH] = {};
    GetModuleFileNameW(g_hInst, modulePath, MAX_PATH);
    g_moduleName = PathFindFileNameW(modulePath);
    PathRemoveFileSpecW(modulePath);
    g_webDir = std::wstring(modulePath) + L"\\web";

    wchar_t configDir[MAX_PATH] = {};
    NppSend(NPPM_GETPLUGINSCONFIGDIR, MAX_PATH, (LPARAM)configDir);
    g_iniPath = std::wstring(configDir) + L"\\mdnotepad.ini";
    LoadSettings();
    Log(L"setInfo: web=%s ini=%s", g_webDir.c_str(), g_iniPath.c_str());
}

__declspec(dllexport) const wchar_t* getName() {
    return kPluginName;
}

__declspec(dllexport) FuncItem* getFuncsArray(int* count) {
    InitFuncItem(CMD_TOGGLE, L"Show/hide preview panel", CmdToggle, false, &g_toggleKey);
    InitFuncItem(CMD_SYNC, L"Sync scroll", CmdSyncScroll, g_syncScroll, nullptr);
    InitFuncItem(CMD_DARK, L"Dark theme", CmdDark, g_dark, nullptr);
    InitFuncItem(CMD_SEPARATOR, L"-", nullptr, false, nullptr);
    InitFuncItem(CMD_PDF, L"Export PDF...", CmdExportPdf, false, nullptr);
    InitFuncItem(CMD_ABOUT, L"About", CmdAbout, false, nullptr);
    *count = CMD_COUNT;
    return g_funcs;
}

__declspec(dllexport) void beNotified(SCNotification* notification) {
    if (!notification) {
        return;
    }
    HWND from = (HWND)notification->nmhdr.hwndFrom;
    if (from == g_npp._nppHandle) {
        switch (notification->nmhdr.code) {
            case NPPN_READY:
                if (g_visible) {
                    // The saved state says the panel was open when Notepad++ was closed.
                    g_visible = false;
                    ShowPanel();
                }
                break;
            case NPPN_TBMODIFICATION:
                AddToolbarButton();
                break;
            case NPPN_BUFFERACTIVATED:
                if (g_visible) {
                    ScheduleUpdate();
                }
                break;
            case NPPN_SHUTDOWN:
                ShutdownWebView();
                break;
            default:
                break;
        }
        return;
    }

    if (!g_visible || !g_pageReady) {
        return;
    }
    if (from != g_npp._scintillaMainHandle && from != g_npp._scintillaSecondHandle) {
        return;
    }
    if (from != CurrentScintilla()) {
        return;
    }
    if (notification->nmhdr.code == SCN_MODIFIED) {
        if (notification->modificationType & (SC_MOD_INSERTTEXT | SC_MOD_DELETETEXT)) {
            ScheduleUpdate();
        }
    } else if (notification->nmhdr.code == SCN_UPDATEUI) {
        SendScroll(false);
    }
}

__declspec(dllexport) LRESULT messageProc(UINT, WPARAM, LPARAM) {
    return TRUE;
}

__declspec(dllexport) BOOL isUnicode() {
    return TRUE;
}

}  // extern "C"
