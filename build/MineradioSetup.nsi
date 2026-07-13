; ============================================================
;  Mineradio — установщик (NSIS + Modern UI 2, русский интерфейс)
; ============================================================
;
; Как использовать:
; 1. Установи NSIS: https://nsis.sourceforge.io/Download
; 2. Рядом с этим .nsi файлом создай папку "build" и скопируй туда
;    ВСЁ содержимое твоей папки Mineradio (resources, locales,
;    Mineradio.exe, все .dll/.pak/.bin и т.д.) — кроме старого
;    "Uninstall Mineradio.exe" (мы создаём свой деинсталлятор).
;    Файл uninstallerIcon.ico — оставь, он используется ниже как иконка.
; 3. ПКМ по этому .nsi файлу → "Compile NSI script" (или открой в
;    NSIS и нажми Compile). Получится MineradioSetup.exe рядом.
;
; Структура должна быть такая:
;   MineradioSetup.nsi   (этот файл)
;   build\
;     Mineradio.exe
;     uninstallerIcon.ico
;     resources\...
;     locales\...
;     ...остальные файлы...
; ============================================================

!include "MUI2.nsh"

; ------------------------------------------------------------
; Общие настройки
; ------------------------------------------------------------
Name "Mineradio"
OutFile "MineradioSetup.exe"
Unicode true
SetCompressor /SOLID lzma

; Ставим в папку пользователя — админ-права не нужны
InstallDir "$LOCALAPPDATA\Programs\Mineradio"
InstallDirRegKey HKCU "Software\Mineradio" "InstallDir"
RequestExecutionLevel user

!define PRODUCT_NAME "Mineradio"
!define PRODUCT_VERSION "1.0.0"
!define PRODUCT_PUBLISHER "Mineradio"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mineradio"

; ------------------------------------------------------------
; Внешний вид
; ------------------------------------------------------------
!define MUI_ICON "build\uninstallerIcon.ico"
!define MUI_UNICON "build\uninstallerIcon.ico"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Добро пожаловать в установку Mineradio"
!define MUI_WELCOMEPAGE_TEXT "Сейчас будет установлен Mineradio на этот компьютер.$\r$\n$\r$\nНажмите «Далее», чтобы продолжить."

!define MUI_DIRECTORYPAGE_TEXT_TOP "Выберите папку, в которую будет установлен Mineradio."

!define MUI_FINISHPAGE_TITLE "Установка завершена"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Mineradio.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Запустить Mineradio"
!define MUI_UNCONFIRMPAGE_TEXT_TOP "Mineradio будет удалён со следующим содержимым папки:"

; ------------------------------------------------------------
; Страницы установщика
; ------------------------------------------------------------
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

; ------------------------------------------------------------
; Страницы деинсталлятора
; ------------------------------------------------------------
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

; ------------------------------------------------------------
; Язык — русский (единственный язык => диалог выбора не появится)
; ------------------------------------------------------------
!insertmacro MUI_LANGUAGE "Russian"

; ------------------------------------------------------------
; Секция установки
; ------------------------------------------------------------
Section "Mineradio" SecMain
  SetOutPath "$INSTDIR"
  ; Копируем всё содержимое папки build рекурсивно
  File /r "build\*.*"

  ; Деинсталлятор
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Ярлыки в меню "Пуск"
  CreateDirectory "$SMPROGRAMS\Mineradio"
  CreateShortcut "$SMPROGRAMS\Mineradio\Mineradio.lnk" "$INSTDIR\Mineradio.exe" "" "$INSTDIR\Mineradio.exe" 0
  CreateShortcut "$SMPROGRAMS\Mineradio\Удалить Mineradio.lnk" "$INSTDIR\Uninstall.exe"

  ; Ярлык на рабочем столе
  CreateShortcut "$DESKTOP\Mineradio.lnk" "$INSTDIR\Mineradio.exe" "" "$INSTDIR\Mineradio.exe" 0

  ; Запоминаем путь установки
  WriteRegStr HKCU "Software\Mineradio" "InstallDir" "$INSTDIR"

  ; Запись в "Программы и компоненты"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayName"     "${PRODUCT_NAME}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayVersion"  "${PRODUCT_VERSION}"
  WriteRegStr   HKCU "${UNINST_KEY}" "Publisher"       "${PRODUCT_PUBLISHER}"
  WriteRegStr   HKCU "${UNINST_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr   HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayIcon"     "$INSTDIR\Mineradio.exe"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

; ------------------------------------------------------------
; Секция удаления
; ------------------------------------------------------------
Section "Uninstall"
  RMDir /r "$INSTDIR"

  Delete "$SMPROGRAMS\Mineradio\Mineradio.lnk"
  Delete "$SMPROGRAMS\Mineradio\Удалить Mineradio.lnk"
  RMDir  "$SMPROGRAMS\Mineradio"
  Delete "$DESKTOP\Mineradio.lnk"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\Mineradio"
SectionEnd
