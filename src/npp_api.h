// Minimal subset of the Notepad++ plugin interface (x64, Unicode) used by this plugin.
// Values follow PluginInterface.h, Notepad_plus_msgs.h, Docking.h and Scintilla.h of Notepad++ 8.x.
#pragma once
#include <windows.h>
#include <stddef.h>
#include <stdint.h>

struct NppData {
    HWND _nppHandle;
    HWND _scintillaMainHandle;
    HWND _scintillaSecondHandle;
};

typedef void(__cdecl* PFUNCPLUGINCMD)();

struct ShortcutKey {
    bool _isCtrl;
    bool _isAlt;
    bool _isShift;
    UCHAR _key;
};

const int menuItemSize = 64;

struct FuncItem {
    wchar_t _itemName[menuItemSize];
    PFUNCPLUGINCMD _pFunc;
    int _cmdID;
    bool _init2Check;
    ShortcutKey* _pShKey;
};

// Scintilla notification (layout of Scintilla.h, SCNotification)
struct SciNotifyHeader {
    void* hwndFrom;
    uintptr_t idFrom;
    unsigned int code;
};

struct SCNotification {
    SciNotifyHeader nmhdr;
    ptrdiff_t position;
    int ch;
    int modifiers;
    int modificationType;
    const char* text;
    ptrdiff_t length;
    ptrdiff_t linesAdded;
    int message;
    uintptr_t wParam;
    intptr_t lParam;
    ptrdiff_t line;
    int foldLevelNow;
    int foldLevelPrev;
    int margin;
    int listType;
    int x;
    int y;
    int token;
    ptrdiff_t annotationLinesAdded;
    int updated;
    int listCompletionMethod;
    int characterSource;
};

// ---- Notepad++ messages ----
#define NPPMSG (WM_USER + 1000)
#define NPPM_GETCURRENTSCINTILLA (NPPMSG + 4)
#define NPPM_DMMSHOW (NPPMSG + 30)
#define NPPM_DMMHIDE (NPPMSG + 31)
#define NPPM_DMMREGASDCKDLG (NPPMSG + 33)
#define NPPM_SETMENUITEMCHECK (NPPMSG + 40)
#define NPPM_GETPLUGINSCONFIGDIR (NPPMSG + 46)
#define RUNCOMMAND_USER (WM_USER + 3000)
#define NPPM_GETFULLCURRENTPATH (RUNCOMMAND_USER + 1)

// ---- Notepad++ notifications ----
#define NPPN_FIRST 1000
#define NPPN_READY (NPPN_FIRST + 1)
#define NPPN_SHUTDOWN (NPPN_FIRST + 9)
#define NPPN_BUFFERACTIVATED (NPPN_FIRST + 10)

// ---- docking ----
#define CONT_RIGHT 1
#define DWS_DF_CONT_RIGHT (CONT_RIGHT << 28)
#define DMN_FIRST 1050
#define DMN_CLOSE (DMN_FIRST + 1)

struct tTbData {
    HWND hClient;
    const wchar_t* pszName;
    int dlgID;
    UINT uMask;
    HICON hIconTab;
    const wchar_t* pszAddInfo;
    RECT rcFloat;
    int iPrevCont;
    const wchar_t* pszModuleName;
};

// ---- Scintilla messages / notifications ----
#define SCI_GETLENGTH 2006
#define SCI_GETCODEPAGE 2137
#define SCI_GETFIRSTVISIBLELINE 2152
#define SCI_GETLINECOUNT 2154
#define SCI_GETTEXT 2182
#define SCI_VISIBLEFROMDOCLINE 2220
#define SCI_GETENDATLASTLINE 2278
#define SCI_LINESONSCREEN 2370
#define SCN_UPDATEUI 2007
#define SCN_MODIFIED 2008
#define SC_MOD_INSERTTEXT 0x1
#define SC_MOD_DELETETEXT 0x2
