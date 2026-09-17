!include nsDialogs.nsh
!include LogicLib.nsh

!define CODEX_WEB_GPT_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define CODEX_WEB_GPT_RUN_VALUE "Codex Web GPT"

!ifndef BUILD_UNINSTALLER
Var CodexWebGptLoginCheckbox
Var CodexWebGptLoginDialog

LangString CodexWebGptStartupRecovery 1033 "Enable startup recovery after an unexpected shutdown (adds a per-user Windows startup entry)"
LangString CodexWebGptStartupRecovery 2052 "启用异常关机后的启动恢复（添加当前用户的 Windows 启动项）"
LangString CodexWebGptStartupRecovery 1028 "啟用異常關機後的啟動復原（新增目前使用者的 Windows 啟動項目）"
LangString CodexWebGptStartupRecovery 1041 "予期しない終了後の起動時復旧を有効にする（現在のユーザーの Windows スタートアップ項目を追加）"
LangString CodexWebGptStartupRecovery 1042 "예기치 않은 종료 후 시작 복구 사용(현재 사용자의 Windows 시작 항목 추가)"

!macro customPageAfterChangeDir
  Page custom CodexWebGptStartupRecoveryPage
!macroend

Function CodexWebGptStartupRecoveryPage
  nsDialogs::Create 1018
  Pop $CodexWebGptLoginDialog
  ${If} $CodexWebGptLoginDialog == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 0 100% 18u "$(CodexWebGptStartupRecovery)"
  Pop $CodexWebGptLoginCheckbox
  ReadRegStr $0 HKCU "${CODEX_WEB_GPT_RUN_KEY}" "${CODEX_WEB_GPT_RUN_VALUE}"
  ${If} $0 != ""
    ${NSD_SetState} $CodexWebGptLoginCheckbox ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $CodexWebGptLoginCheckbox ${BST_UNCHECKED}
  ${EndIf}
  nsDialogs::Show
FunctionEnd

!macro customInstall
  ${NSD_GetState} $CodexWebGptLoginCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    WriteRegStr HKCU "${CODEX_WEB_GPT_RUN_KEY}" "${CODEX_WEB_GPT_RUN_VALUE}" '"$INSTDIR\Codex Web GPT.exe" --hidden'
  ${Else}
    DeleteRegValue HKCU "${CODEX_WEB_GPT_RUN_KEY}" "${CODEX_WEB_GPT_RUN_VALUE}"
  ${EndIf}
!macroend
!endif

!macro customUnInstall
  DeleteRegValue HKCU "${CODEX_WEB_GPT_RUN_KEY}" "${CODEX_WEB_GPT_RUN_VALUE}"
!macroend
