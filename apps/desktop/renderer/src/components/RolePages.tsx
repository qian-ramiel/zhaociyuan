import { t } from '../i18n';
import { useState } from 'react';
import { ArrowLeft, Download, Pencil, Play, Plus, Trash2, Upload, UserRound } from 'lucide-react';
import { api, downloadJson, upload } from '../api';
import type { Bootstrap, Page } from '../types';
import { Empty, Field, IconButton, Modal, PageHeader, Row, SaveButton, Toggle } from './Ui';

type Action = (operation: () => Promise<unknown>, message?: string) => Promise<void>;
interface Shared { data: Bootstrap; action: Action; reload: () => Promise<void> }

export function RolesPage({ data, action, reload, select }: Shared & { select: (id: string, page?: Page) => Promise<void> }) {
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [name, setName] = useState('');
  const [intro, setIntro] = useState('');
  const [personality, setPersonality] = useState('');
  const create = () => action(async () => {
    const role = await api<{ id: string }>('/api/roles', 'POST', { name, intro, personality });
    setCreating(false); await select(role.id, 'appearances');
  }, t("角色已创建"));
  const importFile = (file: File) => action(async () => {
    const result = await upload<{ id: string; missingAppearanceResources: number }>('/api/roles/import', file, file.name);
    await select(result.id, 'persona');
    if (result.missingAppearanceResources) throw new Error(t("角色已导入，{{v0}} 套形象缺少资源，请重新绑定", { v0: result.missingAppearanceResources }));
  }, t("角色已导入"));
  const commands = <><button className="primary" onClick={() => setCreating(true)}><Plus size={16} />{t("创建角色")}</button><label className="secondary upload-button"><Upload size={16} />{t("导入角色")}<input type="file" accept=".json" onChange={(e) => { const file = e.target.files?.[0]; if (file) void importFile(file); e.target.value = ''; }} /></label></>;
  return <div className="management-page"><PageHeader title={t("角色库")} subtitle={t("{{v0}} 个角色", { v0: data.roles.length })}>{data.roles.length > 0 && commands}{data.activeRoleId && <IconButton title={t("导出当前角色")} onClick={() => setExporting(true)}><Download size={16} /></IconButton>}</PageHeader>
    {!data.roles.length ? <div className="role-onboarding"><UserRound size={54} strokeWidth={1.2} /><h2>{t("还没有角色")}</h2><div className="form-footer">{commands}</div></div> : <div className="role-list">{data.roles.map((role) => <article className="role-item" key={role.id}><div className="role-thumb">{role.previewUrl ? <img src={role.previewUrl} alt={role.name} /> : <UserRound size={36} />}</div><div className="role-info"><h2>{role.name}{role.id === data.activeRoleId && <span className="badge teal">{t("当前陪伴")}</span>}</h2><p>{role.appearanceCount}{' ' + t("个形象 ·") + ' '}{role.modeCount}{' ' + t("个模式")}</p><small>{role.intro}</small></div><div className="role-actions"><button className={role.id === data.activeRoleId ? 'secondary' : 'primary'} onClick={() => action(() => select(role.id, 'companion'))}><Play size={15} />{t("开始陪伴")}</button><button className="secondary" onClick={() => action(() => select(role.id, 'persona'))}><Pencil size={15} />{t("进入配置")}</button><IconButton title={t("删除角色 ") + role.name} onClick={() => action(async () => { if (!confirm(t("删除「{{v0}}」及其配置、聊天和记忆？共享形象资源仍会保留。", { v0: role.name }))) return; await api('/api/roles/' + role.id, 'DELETE'); await reload(); }, t("角色已删除"))}><Trash2 size={15} /></IconButton></div></article>)}</div>}
    {exporting && <Modal title={t("导出角色")} onClose={() => setExporting(false)}><div className="modal-body"><RoleExport data={data} action={action} /></div></Modal>}
    {creating && <Modal title={t("创建角色")} onClose={() => setCreating(false)}><div className="modal-body"><Field label={t("角色名称")}><input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label={t("角色简介")}><input value={intro} onChange={(e) => setIntro(e.target.value)} /></Field><Field label={t("基础人设")}><textarea rows={4} value={personality} onChange={(e) => setPersonality(e.target.value)} /></Field><div className="modal-footer"><button className="secondary" onClick={() => setCreating(false)}>{t("取消")}</button><button className="primary" disabled={!name.trim()} onClick={create}><Plus size={16} />{t("创建角色")}</button></div></div></Modal>}
  </div>;
}

export function ProfilesPage({ data, action, reload, onBack }: Shared & { onBack?: () => void }) {
  const [name, setName] = useState('');
  return <div className="management-page"><PageHeader title={t("服务方案库")}>{onBack && <button className="secondary" onClick={onBack}><ArrowLeft size={16} />{t("返回角色配置")}</button>}</PageHeader><div className="form-footer"><input aria-label={t("方案名称")} placeholder={t("方案名称")} value={name} onChange={(e) => setName(e.target.value)} /><button className="primary" disabled={!name.trim() || !data.activeRoleId} onClick={() => action(async () => { await api('/api/profiles', 'POST', { name, providers: data.settings.providers }); setName(''); await reload(); }, t("当前角色的连接方案已保存，不含密钥"))}><Plus size={16} />{t("保存当前方案")}</button><label className="secondary upload-button"><Upload size={16} />{t("导入方案")}<input type="file" accept=".json" onChange={(e) => { const file = e.target.files?.[0]; if (file) void action(async () => { if (file.size > 1024 * 1024) throw new Error(t("方案文件过大")); const value = JSON.parse(await file.text()); if (value.format !== 'nice-people-profile') throw new Error(t("方案格式无效")); await api('/api/profiles', 'POST', value); await reload(); }, t("方案已导入")); e.target.value = ''; }} /></label></div>
    <div className="profile-table"><div className="table-heading"><span>{t("方案名称")}</span><span>{t("对话模型")}</span><span>{t("声音")}</span><span>{t("操作")}</span></div>{data.profiles.map((p) => <div className="profile-row" key={p.id}><strong>{p.name}</strong><span>{p.providers.llm.model || t("未配置")}</span><span>{p.providers.tts.voice}</span><div className="item-actions"><button className="secondary" disabled={!data.activeRoleId} onClick={() => action(async () => { if (!confirm(t("应用到「{{v0}}」？将替换连接配置并清除该角色旧密钥。", { v0: data.settings.persona.characterName }))) return; await api('/api/profiles/' + p.id + '/apply', 'POST'); await reload(); }, t("已复制到当前角色，请填写密钥"))}>{t("应用到角色")}</button><IconButton title={t("导出方案")} onClick={() => downloadJson(p.name + '.json', { format: 'nice-people-profile', name: p.name, providers: p.providers })}><Download size={16} /></IconButton><IconButton title={t("删除方案")} onClick={() => action(async () => { await api('/api/profiles/' + p.id, 'DELETE'); await reload(); })}><Trash2 size={16} /></IconButton></div></div>)}</div>{!data.profiles.length && <Empty>{t("暂无连接方案")}</Empty>}
  </div>;
}

function RoleExport({ data, action }: { data: Bootstrap; action: Action }) {
  const [resources, setResources] = useState(true);
  const [memories, setMemories] = useState(false);
  const [chats, setChats] = useState(false);
  return <><Row label={t("当前角色")}><strong>{data.settings.persona.characterName}</strong></Row><Row label={t("包含形象资源")}><Toggle label={t("包含形象资源")} checked={resources} onChange={setResources} /></Row><Row label={t("包含长期记忆")}><Toggle label={t("包含长期记忆")} checked={memories} onChange={setMemories} /></Row><Row label={t("包含聊天记录")}><Toggle label={t("包含聊天记录")} checked={chats} onChange={setChats} /></Row><div className="status-note">{t("不包含 API 密钥。仅打包你有权分享的形象资源。")}</div><div className="form-footer"><button className="primary" onClick={() => action(async () => { downloadJson(data.settings.persona.characterName + '-角色.json', await api(`/api/roles/export?resources=${resources}&memories=${memories}&chats=${chats}`)); }, t("角色已导出"))}><Download size={16} />{t("导出角色")}</button></div></>;
}
