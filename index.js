/**
 * ☯ 天道因果循环 (Karma Cycle) - SillyTavern Third-Party Extension
 *
 * 核心特性：
 * 1. 识别正文内容 + 世界书（World Info）法则与角色设定，自动判定角色善恶因果。
 * 2. 混合判定引擎：支持【正文末尾隐藏 <karma> 标签解析（零额外Token）】与【后台静默 AI / 独立副模型判定】。
 * 3. “不是不报，时候未到” —— 天道轮盘延时清算机制：
 *    - 每次善恶之举生成一枚“未结因果引子（Causal Seed）”，需经历潜伏期（Latent Turns）酝酿。
 *    - 潜伏期后，随累积业力/功德值与拖延回合数动态提升轮盘触发概率（Trigger Probability）。
 *    - 一旦轮盘命中（或手动降劫/赐福），自动调出具体“历史旧账”并在下一轮生成时注入【天道因果清算指令】。
 * 4. 可视化“生死簿 · 天道因果账本”悬浮面板与聊天内因果提示条。
 */

const MODULE_NAME = 'st_karma_cycle';
const PROMPT_KEY_DIRECTOR = 'st_karma_cycle_director';
const PROMPT_KEY_INLINE_RULE = 'st_karma_cycle_inline_rule';

const DEFAULT_SETTINGS = {
    enabled: true,
    showFab: true,
    showChatBadge: true,
    stripInlineTag: true,

    // 判定模式: 'hybrid' (混合：优先解析正文标签，无标签则按间隔后台判定) | 'inline' (仅正文内嵌标签) | 'quiet' (仅后台静默API判定)
    judgeMode: 'hybrid',
    judgeInterval: 1, // 后台静默判定间隔回合数
    includeWorldInfo: true, // 判定时是否读取并参考世界书与角色背景
    worldInfoKeywords: '因果,天道,善恶,报应,功德,业力,禁忌,戒律,门规,法则,宿命,罪孽,福报', // 优先提取的世界书关键词（留空则提取所有激活条目）
    maxWorldInfoChars: 2500, // 注入给判定模型的世界书最大字符数

    // 天道轮盘（延时清算）核心参数 —— “不是不报，时候未到”
    latentTurns: 3, // 因果潜伏期（结下因果后至少等待几回合才进入轮盘清算池）
    cooldownTurns: 4, // 两次大报应/大福报之间的冷却回合数
    triggerThreshold: 25, // 成熟未结因果触发轮盘的最低绝对值阈值
    baseTriggerChance: 15, // 达标后的基础触发概率 (%)
    karmaWeight: 1.2, // 每超出阈值 1 点因果值增加的触发概率 (%)
    turnWeight: 8, // 每多拖延 1 回合增加的触发概率 (%)
    settleRatio: 0.75, // 每次清算后消解的已成熟未结因果比例 (0~1)

    // 导演指令注入设置
    injectPosition: 1, // 1 = In-chat @ Depth, 0 = After Main Prompt
    injectDepth: 1, // 注入深度 @D1
    injectRole: 0, // 0 = System, 1 = User, 2 = Assistant
    injectAuraSummary: true, // 是否常驻注入简短的角色气运/业障状态描述

    // 独立副模型 API 设置（可选，不开启则默认使用酒馆当前连接 API）
    useCustomApi: false,
    customApiUrl: 'https://api.openai.com/v1',
    customApiKey: '',
    customApiModel: 'gpt-4o-mini',
};

// 运行时状态缓存
let stWorldInfoModule = null;

/**
 * 获取酒馆上下文
 */
function getSTContext() {
    if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
        return SillyTavern.getContext();
    }
    return window;
}

/**
 * 尝试动态加载酒馆 world-info 模块（兼容不同安装层级）
 */
async function ensureWorldInfoModule() {
    if (stWorldInfoModule) return stWorldInfoModule;
    const candidatePaths = [
        '../../../world-info.js',
        '../../world-info.js',
        '/scripts/world-info.js',
    ];
    for (const path of candidatePaths) {
        try {
            stWorldInfoModule = await import(path);
            if (stWorldInfoModule) return stWorldInfoModule;
        } catch (_) {
            // 继续尝试下一个路径
        }
    }
    return null;
}

/**
 * 获取插件全局设置
 */
function getSettings() {
    const ctx = getSTContext();
    if (!ctx.extensionSettings) {
        ctx.extensionSettings = {};
    }
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    } else {
        for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
            if (ctx.extensionSettings[MODULE_NAME][k] === undefined) {
                ctx.extensionSettings[MODULE_NAME][k] = v;
            }
        }
    }
    return ctx.extensionSettings[MODULE_NAME];
}

/**
 * 保存插件全局设置
 */
function saveSettings() {
    const ctx = getSTContext();
    if (typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
}

/**
 * 创建空的当前对话因果账本数据结构
 */
function createEmptyLedger() {
    return {
        turnCounter: 0,
        lastJudgedMessageId: -1,
        characters: {}, // { [charName]: CharacterKarmaRecord }
        pendingSettlements: [], // 待在下一轮触发的清算指令队列
        historyLogs: [], // 历史因果与清算日志
        worldLoreScanned: false,
    };
}

/**
 * 创建单个角色的因果档案
 */
function createCharacterRecord(name) {
    return {
        name,
        totalKarma: 0, // 综合善恶值（正为功德善业，负为罪孽恶业）
        goodAccumulated: 0, // 历史累计善功
        evilAccumulated: 0, // 历史累计恶业
        lastSettlementTurn: -999, // 上次遭遇报应/福报的回合
        currentRollChance: 0, // 当前天道轮盘触发概率 (%)
        statusTags: [], // 当前气运/业障状态标签，如 ["业障暗生", "功德护体"]
        seeds: [], // 因果引子列表: [{ id, turn, delta, deed, target, ruleRef, minDelayTurns, settled, settledTurn }]
    };
}

/**
 * 获取当前聊天的因果账本（优先存储在 chatMetadata 中，随聊天存档绑定）
 */
function getChatLedger() {
    const ctx = getSTContext();
    if (!ctx.chatMetadata) {
        ctx.chatMetadata = {};
    }
    if (!ctx.chatMetadata[MODULE_NAME]) {
        ctx.chatMetadata[MODULE_NAME] = createEmptyLedger();
    }
    const ledger = ctx.chatMetadata[MODULE_NAME];
    if (!ledger.characters) ledger.characters = {};
    if (!Array.isArray(ledger.pendingSettlements)) ledger.pendingSettlements = [];
    if (!Array.isArray(ledger.historyLogs)) ledger.historyLogs = [];
    if (typeof ledger.turnCounter !== 'number') {
        ledger.turnCounter = Array.isArray(ctx.chat) ? Math.max(0, ctx.chat.length) : 0;
    }
    return ledger;
}

/**
 * 保存当前聊天的因果账本
 */
async function saveChatLedger() {
    const ctx = getSTContext();
    if (typeof ctx.saveMetadataDebounced === 'function') {
        ctx.saveMetadataDebounced();
    } else if (typeof ctx.saveMetadata === 'function') {
        await ctx.saveMetadata();
    }
}

/**
 * 根据因果分数计算品阶称号与报应烈度
 */
function getKarmaTierInfo(score) {
    const abs = Math.abs(score);
    const isGood = score >= 0;

    if (abs < 15) {
        return {
            title: '因果平淡',
            aura: '气运平稳，暂未结下深重因果',
            severityName: '微澜',
            severityLevel: 0,
        };
    }
    if (abs < 40) {
        return {
            title: isGood ? '小有善功' : '业障初显',
            aura: isGood ? '善气萦绕，偶有顺遂之兆' : '晦气暗生，诸事易生波折',
            severityName: isGood ? '微福小利' : '小惩小戒',
            severityLevel: 1,
        };
    }
    if (abs < 70) {
        return {
            title: isGood ? '功德护体' : '罪业缠身',
            aura: isGood ? '福泽深厚，逢凶化吉' : '冤孽随行，隐患四伏',
            severityName: isGood ? '天赐机缘' : '中度反噬',
            severityLevel: 2,
        };
    }
    if (abs < 100) {
        return {
            title: isGood ? '大善福星' : '恶贯满盈',
            aura: isGood ? '气运昌隆，百邪辟易' : '煞气冲霄，随时面临大劫',
            severityName: isGood ? '大造化/贵人奇遇' : '重劫/众叛亲离',
            severityLevel: 3,
        };
    }
    return {
        title: isGood ? '功德圆满' : '天诛地灭',
        aura: isGood ? '天道眷顾，绝处亦能逢生' : '天道锁定，必遭雷霆清算',
        severityName: isGood ? '逆天福报/宿命恩赐' : '天谴绝境/宿命总清算',
        severityLevel: 4,
    };
}

/**
 * 提取当前激活的世界书（World Info）与角色卡背景信息
 */
async function extractWorldInfoAndCharacterLore() {
    const settings = getSettings();
    const ctx = getSTContext();
    const sections = [];

    // 1. 提取当前主角色卡信息
    try {
        const charId = ctx.characterId;
        const charObj = (ctx.characters && charId !== undefined) ? ctx.characters[charId] : null;
        if (charObj) {
            const charDesc = [
                charObj.name ? `【主角色名】：${charObj.name}` : '',
                charObj.description ? `【角色设定】：${charObj.description.slice(0, 800)}` : '',
                charObj.personality ? `【性格特征】：${charObj.personality.slice(0, 300)}` : '',
                charObj.scenario ? `【背景处境】：${charObj.scenario.slice(0, 400)}` : '',
            ].filter(Boolean).join('\n');
            if (charDesc) {
                sections.push(`=== 角色卡设定 ===\n${charDesc}`);
            }
        }
    } catch (e) {
        console.warn('[KarmaCycle] 读取角色卡信息失败:', e);
    }

    if (!settings.includeWorldInfo) {
        return sections.join('\n\n').slice(0, settings.maxWorldInfoChars);
    }

    // 2. 提取世界书（World Info）条目
    try {
        const wiMod = await ensureWorldInfoModule();
        const bookNames = new Set();

        // 角色绑定的世界书
        const charId = ctx.characterId;
        const charObj = (ctx.characters && charId !== undefined) ? ctx.characters[charId] : null;
        const charWorld = charObj?.data?.extensions?.world;
        if (charWorld) bookNames.add(charWorld);

        // 聊天绑定的世界书
        const chatWorld = ctx.chatMetadata?.world_info;
        if (chatWorld) bookNames.add(chatWorld);

        // 全局选中的世界书
        if (Array.isArray(wiMod?.selected_world_info)) {
            wiMod.selected_world_info.forEach(b => b && bookNames.add(b));
        }

        const filterKws = (settings.worldInfoKeywords || '')
            .split(/[,，、\s]+/)
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);

        // 最近3条聊天文本，用于匹配触发词
        const recentChatText = (ctx.chat || [])
            .slice(-4)
            .map(m => m?.mes || '')
            .join('\n')
            .toLowerCase();

        const matchedEntries = [];

        const loadBookFn = wiMod?.loadWorldInfo || ctx.loadWorldInfo;
        if (typeof loadBookFn === 'function') {
            for (const bookName of bookNames) {
                try {
                    const bookData = await loadBookFn(bookName);
                    if (!bookData || !bookData.entries) continue;

                    for (const entry of Object.values(bookData.entries)) {
                        if (!entry || entry.disable) continue;
                        const content = (entry.content || '').trim();
                        if (!content) continue;

                        const comment = (entry.comment || '').trim();
                        const keys = Array.isArray(entry.key) ? entry.key.join(',') : (entry.key || '');
                        const combinedLower = `${comment} ${keys} ${content}`.toLowerCase();

                        // 判断是否为天道法则/善恶相关条目，或常驻条目，或被近期对话激活的条目
                        const isConstant = Boolean(entry.constant);
                        const matchesRuleKw = filterKws.length === 0 || filterKws.some(kw => combinedLower.includes(kw));
                        const matchesChatKey = Array.isArray(entry.key) && entry.key.some(k => k && recentChatText.includes(String(k).toLowerCase()));

                        if (isConstant || matchesRuleKw || matchesChatKey) {
                            matchedEntries.push({
                                priority: matchesRuleKw ? 2 : (matchesChatKey ? 1 : 0),
                                text: `[${comment || keys || '世界书条目'}]: ${content.slice(0, 450)}`,
                            });
                        }
                    }
                } catch (bookErr) {
                    console.warn(`[KarmaCycle] 读取世界书 ${bookName} 失败:`, bookErr);
                }
            }
        }

        if (matchedEntries.length > 0) {
            matchedEntries.sort((a, b) => b.priority - a.priority);
            const wiText = matchedEntries.slice(0, 8).map(e => e.text).join('\n');
            sections.push(`=== 世界书（法则与设定参考） ===\n${wiText}`);
        }
    } catch (e) {
        console.warn('[KarmaCycle] 提取世界书失败:', e);
    }

    return sections.join('\n\n').slice(0, settings.maxWorldInfoChars || 2500);
}

/**
 * 向账本中记录一条新的因果变动（Causal Seed）
 */
function recordKarmaEvent(charName, delta, deed, options = {}) {
    if (!charName || !delta || isNaN(delta)) return null;
    const cleanName = String(charName).trim();
    if (!cleanName) return null;

    const settings = getSettings();
    const ledger = getChatLedger();
    const turn = ledger.turnCounter;

    if (!ledger.characters[cleanName]) {
        ledger.characters[cleanName] = createCharacterRecord(cleanName);
    }
    const charRec = ledger.characters[cleanName];

    const numDelta = Math.round(Number(delta));
    if (numDelta === 0) return null;

    charRec.totalKarma += numDelta;
    if (numDelta > 0) {
        charRec.goodAccumulated += numDelta;
    } else {
        charRec.evilAccumulated += Math.abs(numDelta);
    }

    const minDelay = options.minDelayTurns !== undefined
        ? Number(options.minDelayTurns)
        : Number(settings.latentTurns ?? 3);

    const seed = {
        id: `seed_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        turn,
        delta: numDelta,
        remainingDelta: numDelta, // 尚未清算的残余因果值
        deed: String(deed || (numDelta > 0 ? '行善积德' : '作恶多端')).trim(),
        target: options.target ? String(options.target).trim() : '',
        ruleRef: options.ruleRef ? String(options.ruleRef).trim() : '',
        minDelayTurns: Math.max(0, minDelay),
        settled: false,
        settledTurn: null,
    };

    charRec.seeds.push(seed);
    // 限制每个角色最多保留最近 40 条引子防止膨胀
    if (charRec.seeds.length > 40) {
        charRec.seeds = charRec.seeds.slice(-40);
    }

    const tierInfo = getKarmaTierInfo(charRec.totalKarma);
    charRec.statusTags = [tierInfo.title];

    // 写入历史流水
    ledger.historyLogs.unshift({
        id: seed.id,
        type: 'seed',
        turn,
        character: cleanName,
        delta: numDelta,
        deed: seed.deed,
        ruleRef: seed.ruleRef,
        timestamp: new Date().toLocaleTimeString(),
    });
    if (ledger.historyLogs.length > 60) {
        ledger.historyLogs = ledger.historyLogs.slice(0, 60);
    }

    return seed;
}

/**
 * 计算某个角色当前的“已过潜伏期（Mature）”未结因果与天道轮盘触发概率
 * 核心理念：“不是不报，时候未到”
 */
function calculateCharacterRoulette(charRec, currentTurn) {
    const settings = getSettings();
    const seeds = Array.isArray(charRec.seeds) ? charRec.seeds : [];

    let matureGood = 0;
    let matureEvil = 0; // 以正数表示累积恶业绝对值
    let latentGood = 0;
    let latentEvil = 0;
    let oldestMatureTurn = currentTurn;
    const matureEvilSeeds = [];
    const matureGoodSeeds = [];

    for (const s of seeds) {
        if (s.settled) continue;
        const rem = s.remainingDelta !== undefined ? s.remainingDelta : s.delta;
        if (!rem) continue;

        const turnsWaited = Math.max(0, currentTurn - (s.turn || 0));
        const requiredWait = s.minDelayTurns !== undefined ? s.minDelayTurns : settings.latentTurns;

        if (turnsWaited >= requiredWait) {
            // 已度过潜伏期，进入天道清算池
            if (rem > 0) {
                matureGood += rem;
                matureGoodSeeds.push(s);
            } else {
                matureEvil += Math.abs(rem);
                matureEvilSeeds.push(s);
            }
            if ((s.turn || 0) < oldestMatureTurn) {
                oldestMatureTurn = s.turn || 0;
            }
        } else {
            // 仍在潜伏酝酿中
            if (rem > 0) latentGood += rem;
            else latentEvil += Math.abs(rem);
        }
    }

    // 检查是否处于上次报应后的冷却期
    const turnsSinceLastSettle = currentTurn - (charRec.lastSettlementTurn ?? -999);
    const inCooldown = turnsSinceLastSettle < (settings.cooldownTurns ?? 4);

    // 选择当前主导的清算方向（恶业优先或绝对值大者优先）
    const dominantType = matureEvil >= matureGood ? 'retribution' : 'blessing';
    const dominantValue = dominantType === 'retribution' ? matureEvil : matureGood;
    const dominantSeeds = dominantType === 'retribution' ? matureEvilSeeds : matureGoodSeeds;

    const threshold = Number(settings.triggerThreshold ?? 25);
    let triggerChance = 0;

    if (!inCooldown && dominantValue >= threshold) {
        const excessKarma = dominantValue - threshold;
        const overdueTurns = Math.max(0, currentTurn - oldestMatureTurn - (settings.latentTurns ?? 3));

        triggerChance = Math.min(
            100,
            Math.round(
                Number(settings.baseTriggerChance ?? 15) +
                excessKarma * Number(settings.karmaWeight ?? 1.2) +
                overdueTurns * Number(settings.turnWeight ?? 8)
            )
        );
    }

    charRec.currentRollChance = triggerChance;

    return {
        matureGood,
        matureEvil,
        latentGood,
        latentEvil,
        inCooldown,
        cooldownRemaining: Math.max(0, (settings.cooldownTurns ?? 4) - turnsSinceLastSettle),
        dominantType,
        dominantValue,
        dominantSeeds,
        triggerChance,
    };
}

/**
 * 执行每回合的【天道轮盘检定】
 * 若掷骰命中，则生成下一回合的【天道因果清算指令】
 */
function rollKarmaRouletteForAll() {
    const settings = getSettings();
    if (!settings.enabled) return [];

    const ledger = getChatLedger();
    const currentTurn = ledger.turnCounter;
    const newlyTriggered = [];

    for (const charRec of Object.values(ledger.characters)) {
        // 如果该角色已经在待清算队列中，跳过重复投掷
        if (ledger.pendingSettlements.some(p => p.character === charRec.name)) {
            continue;
        }

        const roulette = calculateCharacterRoulette(charRec, currentTurn);
        if (roulette.triggerChance <= 0) continue;

        const roll = Math.floor(Math.random() * 100) + 1; // 1 ~ 100
        if (roll <= roulette.triggerChance) {
            const settlement = buildSettlementDirective(charRec, roulette, roll, false);
            if (settlement) {
                ledger.pendingSettlements.push(settlement);
                newlyTriggered.push(settlement);
            }
        }
    }

    return newlyTriggered;
}

/**
 * 构建一条【天道因果清算指令】（可由轮盘自动触发，或由玩家在面板手动点击触发）
 */
function buildSettlementDirective(charRec, roulette, rollValue = 1, isManual = false) {
    const ledger = getChatLedger();
    const currentTurn = ledger.turnCounter;

    // 如果是手动强制触发且没有成熟种子，则把未成熟的种子也纳入清算
    let targetSeeds = roulette.dominantSeeds;
    let direction = roulette.dominantType;
    let magnitude = roulette.dominantValue;

    if ((!targetSeeds || targetSeeds.length === 0) && isManual) {
        const unsettled = (charRec.seeds || []).filter(s => !s.settled && (s.remainingDelta || s.delta));
        const evilSeeds = unsettled.filter(s => (s.remainingDelta ?? s.delta) < 0);
        const goodSeeds = unsettled.filter(s => (s.remainingDelta ?? s.delta) > 0);
        const evilSum = evilSeeds.reduce((acc, s) => acc + Math.abs(s.remainingDelta ?? s.delta), 0);
        const goodSum = goodSeeds.reduce((acc, s) => acc + (s.remainingDelta ?? s.delta), 0);

        if (evilSum === 0 && goodSum === 0) {
            // 没有任何未结种子时，根据当前总善恶值直接生成宿命指令
            direction = charRec.totalKarma < 0 ? 'retribution' : 'blessing';
            magnitude = Math.max(30, Math.abs(charRec.totalKarma));
            targetSeeds = [];
        } else if (evilSum >= goodSum) {
            direction = 'retribution';
            magnitude = evilSum;
            targetSeeds = evilSeeds;
        } else {
            direction = 'blessing';
            magnitude = goodSum;
            targetSeeds = goodSeeds;
        }
    }

    const signedMagnitude = direction === 'retribution' ? -magnitude : magnitude;
    const tierInfo = getKarmaTierInfo(signedMagnitude);

    const deedSummaries = targetSeeds.slice(0, 5).map(s => {
        const turnLabel = s.turn ? `第${s.turn}回合` : '过往';
        const ruleNote = s.ruleRef ? `（触犯/契合：${s.ruleRef}）` : '';
        return `「${turnLabel}：${s.deed}${ruleNote}」`;
    });

    const deedsText = deedSummaries.length > 0
        ? deedSummaries.join('、')
        : (direction === 'retribution' ? '「过往积累的诸多恶行与业障」' : '「过往积累的诸多善举与阴德」');

    const promptInstruction = direction === 'retribution'
        ? `[☯ 天道因果清算指令 · 恶有恶报]
角色【${charRec.name}】此前种下恶因：${deedsText}，累积待清算恶业达 ${magnitude} 点（烈度等级：${tierInfo.severityName}）。
“善恶终有报，天道好轮回。不信抬头看，苍天饶过谁！”时候已到，请在本轮回复的剧情推进中，自然但明确地让【${charRec.name}】遭遇一次与其过往恶行相呼应的【因果反噬/报应】！
表现要求：
1. 报应形式应当符合当前世界观逻辑（如：曾暗算他人则遭反噬或败露、曾夺人财宝则引发祸端、修行世界可表现为心魔反噬/走火入魔/仇家寻仇，现代/古风可表现为机关算尽反误自身、意外灾祸、众叛亲离）。
2. 烈度需匹配【${tierInfo.severityName}】，在描写中通过细节或巧合暗中点出“正如其当初所作所为的回旋镖/报应”，切勿生硬播报系统数值。`
        : `[☯ 天道因果清算指令 · 善有善报]
角色【${charRec.name}】此前种下善因：${deedsText}，累积待兑现功德达 ${magnitude} 点（福泽等级：${tierInfo.severityName}）。
“积善之家，必有余庆！”机缘已至，请在本轮回复的剧情推进中，自然但明确地让【${charRec.name}】获得一次与其过往善举相呼应的【福报/机缘/贵人相助】！
表现要求：
1. 福报形式应当符合当前世界观逻辑（如：曾救人于危难则获意想不到的回报或庇护、绝境中逢凶化吉、偶得关键线索或突破瓶颈的契机）。
2. 烈度需匹配【${tierInfo.severityName}】，在叙事中自然体现“昔日种下善因，今日终结善果”的宿命感，切勿生硬播报系统数值。`;

    return {
        id: `settle_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        character: charRec.name,
        direction, // 'retribution' | 'blessing'
        magnitude,
        severityName: tierInfo.severityName,
        deedsText,
        seedIds: targetSeeds.map(s => s.id),
        rollValue,
        triggerChance: isManual ? 100 : roulette.triggerChance,
        createdTurn: currentTurn,
        promptInstruction,
    };
}

/**
 * 当带有清算指令的一轮回复生成完毕后，完成账本核销（Settle）
 */
function finalizePendingSettlements() {
    const settings = getSettings();
    const ledger = getChatLedger();
    if (!Array.isArray(ledger.pendingSettlements) || ledger.pendingSettlements.length === 0) {
        return;
    }

    const currentTurn = ledger.turnCounter;
    const ratio = Math.min(1, Math.max(0.1, Number(settings.settleRatio ?? 0.75)));

    for (const item of ledger.pendingSettlements) {
        const charRec = ledger.characters[item.character];
        if (charRec) {
            charRec.lastSettlementTurn = currentTurn;

            // 核销关联的因果引子
            for (const seed of (charRec.seeds || [])) {
                if (item.seedIds.includes(seed.id) && !seed.settled) {
                    const rem = seed.remainingDelta !== undefined ? seed.remainingDelta : seed.delta;
                    const settledAmount = Math.round(rem * ratio);
                    seed.remainingDelta = rem - settledAmount;
                    charRec.totalKarma -= settledAmount; // 清算后部分消解总业力/功德回正
                    if (Math.abs(seed.remainingDelta) <= 3 || ratio >= 0.95) {
                        seed.remainingDelta = 0;
                        seed.settled = true;
                        seed.settledTurn = currentTurn;
                    }
                }
            }

            // 重新计算该角色轮盘概率与状态标签
            calculateCharacterRoulette(charRec, currentTurn);
            const tierInfo = getKarmaTierInfo(charRec.totalKarma);
            charRec.statusTags = [tierInfo.title];
        }

        // 记录到历史清算日志
        ledger.historyLogs.unshift({
            id: item.id,
            type: 'settlement',
            turn: currentTurn,
            character: item.character,
            direction: item.direction,
            magnitude: item.magnitude,
            severityName: item.severityName,
            deedsText: item.deedsText,
            timestamp: new Date().toLocaleTimeString(),
        });
    }

    // 清空已执行的待清算队列
    ledger.pendingSettlements = [];
}

/**
 * 同步更新注入到 SillyTavern 的 Extension Prompts
 */
function syncExtensionPrompts() {
    const ctx = getSTContext();
    if (typeof ctx.setExtensionPrompt !== 'function') return;

    const settings = getSettings();
    if (!settings.enabled) {
        ctx.setExtensionPrompt(PROMPT_KEY_DIRECTOR, '', settings.injectPosition, settings.injectDepth, false, settings.injectRole);
        ctx.setExtensionPrompt(PROMPT_KEY_INLINE_RULE, '', settings.injectPosition, settings.injectDepth, false, settings.injectRole);
        return;
    }

    const ledger = getChatLedger();
    const directorBlocks = [];

    // 1. 注入常驻角色气运/业障概要（可选）
    if (settings.injectAuraSummary) {
        const charSummaries = Object.values(ledger.characters)
            .filter(c => Math.abs(c.totalKarma) >= 15)
            .map(c => {
                const tier = getKarmaTierInfo(c.totalKarma);
                const sign = c.totalKarma > 0 ? `+${c.totalKarma}` : `${c.totalKarma}`;
                return `- ${c.name}：当前因果值 ${sign}（${tier.title} · ${tier.aura}）`;
            });
        if (charSummaries.length > 0) {
            directorBlocks.push(`[天道因果账本 · 角色当前气运状态]\n${charSummaries.join('\n')}`);
        }
    }

    // 2. 注入本回合触发的【天道因果清算指令】
    if (Array.isArray(ledger.pendingSettlements) && ledger.pendingSettlements.length > 0) {
        for (const s of ledger.pendingSettlements) {
            directorBlocks.push(s.promptInstruction);
        }
    }

    const finalDirectorPrompt = directorBlocks.join('\n\n');
    ctx.setExtensionPrompt(
        PROMPT_KEY_DIRECTOR,
        finalDirectorPrompt,
        Number(settings.injectPosition ?? 1),
        Number(settings.injectDepth ?? 1),
        false,
        Number(settings.injectRole ?? 0)
    );

    // 3. 若开启了 inline 或 hybrid 模式，注入末尾 <karma> 标签输出规范
    if (settings.judgeMode === 'inline' || settings.judgeMode === 'hybrid') {
        const inlineRulePrompt = `[天道因果记录协议]
在每次正文回复的最末尾，请根据本轮剧情发展与世界观善恶标准，评估出场角色是否有显著的善行（救人、守信、助人、护道等）或恶行（背叛、滥杀、欺诈、破戒、暗算等）。
若有显著善恶行为，请在正文结束后另起一行附上隐藏标签（若本回合平淡无奇则输出 <karma>[]</karma>）：
<karma>[{"char":"角色名","delta":-20,"deed":"简述本回合结下的因果事件","rule":"关联的世界观戒律或道德准则","delay":3}]</karma>
（说明：delta 正数为积德 +5~+50，负数为造孽 -5~-50；delay 为报应潜伏回合数，常规为 2~5）`;

        ctx.setExtensionPrompt(
            PROMPT_KEY_INLINE_RULE,
            inlineRulePrompt,
            1, // In-chat
            0, // @D0 紧贴末尾以确保模型遵循格式
            false,
            0  // System role
        );
    } else {
        ctx.setExtensionPrompt(PROMPT_KEY_INLINE_RULE, '', 1, 0, false, 0);
    }
}

/**
 * 解析并处理正文中内嵌的 <karma>...</karma> 标签
 * 返回解析出的因果事件数组
 */
function parseAndStripInlineKarmaTags(messageObj) {
    if (!messageObj || typeof messageObj.mes !== 'string') return [];

    const karmaRegex = /<karma>([\s\S]*?)<\/karma>/gi;
    const matches = [...messageObj.mes.matchAll(karmaRegex)];
    if (matches.length === 0) return [];

    const recordedEvents = [];
    for (const match of matches) {
        const rawInner = (match[1] || '').trim();
        if (!rawInner || rawInner === '[]') continue;

        const parsedList = tryParseKarmaJson(rawInner);
        for (const item of parsedList) {
            const charName = item.char || item.character || item.name;
            const delta = Number(item.delta ?? item.score ?? 0);
            const deed = item.deed || item.reason || item.event || '';
            const ruleRef = item.rule || item.ruleRef || '';
            const minDelayTurns = item.delay !== undefined ? Number(item.delay) : undefined;

            if (charName && delta !== 0) {
                const seed = recordKarmaEvent(charName, delta, deed, { ruleRef, minDelayTurns });
                if (seed) recordedEvents.push(seed);
            }
        }
    }

    // 如果配置了隐藏正文中裸露的 <karma> 标签，则将其从消息文本中剥离
    const settings = getSettings();
    if (settings.stripInlineTag) {
        messageObj.mes = messageObj.mes.replace(karmaRegex, '').trim();
    }

    return recordedEvents;
}

/**
 * 容错解析 JSON 数组或对象的辅助函数
 */
function tryParseKarmaJson(rawText) {
    if (!rawText) return [];
    let cleaned = rawText
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();

    // 尝试提取 [...] 或 {...}
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (arrMatch) {
        cleaned = arrMatch[0];
    } else if (objMatch) {
        cleaned = `[${objMatch[0]}]`;
    }

    try {
        const data = JSON.parse(cleaned);
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.events)) return data.events;
        if (data && typeof data === 'object') return [data];
    } catch (e) {
        console.warn('[KarmaCycle] JSON 解析失败，原始文本:', rawText, e);
    }
    return [];
}

/**
 * 调用 AI 模型（酒馆静默生成 或 独立副模型 API）执行因果判定
 */
async function runLLMPrompt(promptText) {
    const settings = getSettings();

    // 方案 A：使用独立配置的 OpenAI 兼容副模型接口
    if (settings.useCustomApi && settings.customApiUrl && settings.customApiKey) {
        const baseUrl = settings.customApiUrl.replace(/\/+$/, '');
        const endpoint = baseUrl.endsWith('/chat/completions')
            ? baseUrl
            : `${baseUrl}/chat/completions`;

        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.customApiKey.trim()}`,
            },
            body: JSON.stringify({
                model: settings.customApiModel || 'gpt-4o-mini',
                temperature: 0.2,
                messages: [
                    {
                        role: 'system',
                        content: '你是一个严谨的“天道因果判官”分析引擎，只输出符合要求的 JSON 数组，绝不输出任何额外解释。',
                    },
                    {
                        role: 'user',
                        content: promptText,
                    },
                ],
            }),
        });

        if (!resp.ok) {
            throw new Error(`独立 API 请求失败 (${resp.status}): ${await resp.text()}`);
        }
        const data = await resp.json();
        return data?.choices?.[0]?.message?.content || '[]';
    }

    // 方案 B：使用 SillyTavern 内置的 generateQuietPrompt
    const ctx = getSTContext();
    if (typeof ctx.generateQuietPrompt === 'function') {
        // generateQuietPrompt(quietPrompt, quietToLoud, skipWIAN)
        return await ctx.generateQuietPrompt(promptText, false, true);
    }

    throw new Error('未找到可用的生成接口（generateQuietPrompt 不可用且未配置独立 API）。');
}

/**
 * 后台静默判定最新剧情回合的因果变动
 */
async function judgeLatestTurnWithAI(isManual = false) {
    const ctx = getSTContext();
    const chat = ctx.chat || [];
    if (chat.length === 0) {
        if (isManual && typeof toastr !== 'undefined') {
            toastr.warning('当前没有聊天记录可供判定。', '天道因果循环');
        }
        return [];
    }

    const worldLore = await extractWorldInfoAndCharacterLore();
    const recentMessages = chat.slice(-3).map(m => `${m.name || (m.is_user ? '玩家' : '角色')}: ${m.mes}`).join('\n\n---\n\n');

    const ledger = getChatLedger();
    const existingChars = Object.keys(ledger.characters).join('、') || '暂无记录';

    const judgePrompt = `请作为“天道因果判官”，结合【世界书与角色设定】以及【最新剧情内容】，判定最新一轮剧情中是否有角色结下了新的善因（功德）或恶因（业障）。

${worldLore ? `${worldLore}\n\n` : ''}=== 已知在册角色 ===
${existingChars}

=== 最新剧情内容 ===
${recentMessages}

=== 判定准则 ===
1. 严格依据世界观的道德、门规、禁忌或天道法则以及普世善恶观进行判定：
   - 善因（+5 到 +50）：救死扶伤、信守承诺、暗中助人、替人挡灾、遵守或维护正道戒律等。
   - 恶因（-5 到 -50）：背信弃义、欺凌弱小、暗中下毒/算计、滥杀无辜、夺人机缘、触犯世界观禁忌/戒律等。
2. 只针对【最新一轮剧情】中实际发生的行为计分，不要重复计算更早之前的旧事。
3. 若最新剧情只是日常闲聊或无明显善恶因果，请直接返回空数组 []。
4. 仅输出纯 JSON 数组，格式如下：
[
  {
    "char": "角色姓名",
    "delta": -25,
    "deed": "简述具体善恶行为（25字以内）",
    "rule": "依据的世界书法则或因果缘由（15字以内）",
    "delay": 3
  }
]`;

    try {
        if (isManual && typeof toastr !== 'undefined') {
            toastr.info('正在连接天道推演最新剧情因果……', '☯ 天道因果判定');
        }
        const rawReply = await runLLMPrompt(judgePrompt);
        const items = tryParseKarmaJson(rawReply);
        const recorded = [];

        for (const item of items) {
            const charName = item.char || item.character || item.name;
            const delta = Number(item.delta ?? item.score ?? 0);
            const deed = item.deed || item.reason || '';
            const ruleRef = item.rule || '';
            const minDelayTurns = item.delay !== undefined ? Number(item.delay) : undefined;

            if (charName && delta !== 0) {
                const seed = recordKarmaEvent(charName, delta, deed, { ruleRef, minDelayTurns });
                if (seed) recorded.push(seed);
            }
        }

        if (isManual && typeof toastr !== 'undefined') {
            if (recorded.length > 0) {
                toastr.success(`已记录 ${recorded.length} 条新的因果变动！`, '☯ 天道因果判定');
            } else {
                toastr.info('本回合风平浪静，未检测到显著的善恶因果变动。', '☯ 天道因果判定');
            }
        }
        return recorded;
    } catch (err) {
        console.error('[KarmaCycle] 后台因果判定出错:', err);
        if (isManual && typeof toastr !== 'undefined') {
            toastr.error(`因果判定失败: ${err.message}`, '☯ 天道因果循环');
        }
        return [];
    }
}

/**
 * 扫描世界书（World Info）与角色卡背景，初始化各角色的先天/过往宿命因果
 */
async function scanWorldLoreForInitialKarma() {
    const worldLore = await extractWorldInfoAndCharacterLore();
    if (!worldLore || worldLore.trim().length < 10) {
        if (typeof toastr !== 'undefined') {
            toastr.warning('未读取到有效的角色卡设定或激活的世界书内容。', '☯ 天道因果循环');
        }
        return;
    }

    const scanPrompt = `请作为“天道因果判官”，阅读以下【角色卡与世界书设定】，梳理出其中登场的主要角色，并根据他们在背景故事中的过往所作所为（如：曾犯下灭门/背叛等旧恶，或曾有救世/护道等旧功德），为他们建立初始的“未结因果旧账”。

${worldLore}

=== 输出要求 ===
仅输出纯 JSON 数组，每个元素代表一条角色背景中的未结因果：
[
  {
    "char": "角色名",
    "delta": -35,
    "deed": "背景旧账简述（如：十年前曾为夺秘籍暗算同门）",
    "rule": "违背或契合的法则/门规",
    "delay": 2
  }
]`;

    try {
        if (typeof toastr !== 'undefined') {
            toastr.info('正在扫描世界书与角色背景宿命……', '☯ 天道因果循环');
        }
        const rawReply = await runLLMPrompt(scanPrompt);
        const items = tryParseKarmaJson(rawReply);
        let count = 0;

        for (const item of items) {
            const charName = item.char || item.character || item.name;
            const delta = Number(item.delta ?? item.score ?? 0);
            const deed = item.deed || item.reason || '背景宿命因果';
            const ruleRef = item.rule || '宿命旧账';
            const minDelayTurns = item.delay !== undefined ? Number(item.delay) : 2;

            if (charName && delta !== 0) {
                recordKarmaEvent(charName, delta, `[背景旧账] ${deed}`, { ruleRef, minDelayTurns });
                count++;
            }
        }

        const ledger = getChatLedger();
        ledger.worldLoreScanned = true;
        // 刷新各角色轮盘状态
        for (const c of Object.values(ledger.characters)) {
            calculateCharacterRoulette(c, ledger.turnCounter);
        }
        await saveChatLedger();
        syncExtensionPrompts();
        renderModalIfOpen();
        updateFabBadge();

        if (typeof toastr !== 'undefined') {
            toastr.success(`世界书宿命扫描完成！共提取 ${count} 条先天/过往因果引子。`, '☯ 天道因果循环');
        }
    } catch (err) {
        console.error('[KarmaCycle] 扫描世界书宿命失败:', err);
        if (typeof toastr !== 'undefined') {
            toastr.error(`扫描失败: ${err.message}`, '☯ 天道因果循环');
        }
    }
}

/**
 * 在聊天消息底部渲染天道因果提示小横幅
 */
function renderMessageKarmaBadge(messageId, recordedSeeds, triggeredSettlements) {
    const settings = getSettings();
    if (!settings.showChatBadge) return;
    if ((!recordedSeeds || recordedSeeds.length === 0) && (!triggeredSettlements || triggeredSettlements.length === 0)) {
        return;
    }

    const msgEl = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    if (!msgEl) return;

    // 防止重复插入
    const oldBadge = msgEl.parentElement.querySelector('.st-karma-chat-badge');
    if (oldBadge) oldBadge.remove();

    const parts = [];
    for (const s of (recordedSeeds || [])) {
        const sign = s.delta > 0 ? `+${s.delta}` : `${s.delta}`;
        const cls = s.delta > 0 ? 'tag-good' : 'tag-evil';
        parts.push(`<span class="st-karma-tag ${cls}">${escapeHtml(s.character || '')} ${escapeHtml(s.deed)} (${sign} · 潜伏${s.minDelayTurns}回合)</span>`);
    }

    for (const t of (triggeredSettlements || [])) {
        const label = t.direction === 'retribution' ? '⚡天道恶报已锁定' : '✨天道福报已锁定';
        parts.push(`<span class="st-karma-tag tag-roulette">${label}：${escapeHtml(t.character)}（${escapeHtml(t.severityName)} · 下回合降临）</span>`);
    }

    const badge = document.createElement('div');
    badge.className = 'st-karma-chat-badge';
    badge.innerHTML = `<span class="st-karma-chat-badge-title">☯ 天道记账：</span>${parts.join(' ')}`;
    msgEl.insertAdjacentElement('afterend', badge);
}

/**
 * 当收到 AI 回复消息时的主生命周期钩子
 */
async function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;

    const ctx = getSTContext();
    const chat = ctx.chat || [];
    const msgIndex = typeof messageId === 'number' ? messageId : chat.length - 1;
    const messageObj = chat[msgIndex];
    if (!messageObj || messageObj.is_user) return;

    const ledger = getChatLedger();
    if (ledger.lastJudgedMessageId === msgIndex) return;
    ledger.lastJudgedMessageId = msgIndex;
    ledger.turnCounter = (ledger.turnCounter || 0) + 1;

    // 1. 若上一回合存在待清算指令，说明本条回复已经执行了该因果报应/福报，先予以核销
    if (Array.isArray(ledger.pendingSettlements) && ledger.pendingSettlements.length > 0) {
        finalizePendingSettlements();
    }

    // 2. 执行本回合善恶因果判定
    let recordedSeeds = [];

    if (settings.judgeMode === 'inline' || settings.judgeMode === 'hybrid') {
        recordedSeeds = parseAndStripInlineKarmaTags(messageObj);
        // 如果剥离了 <karma> 标签，同步更新 DOM 中的消息展示
        if (settings.stripInlineTag) {
            const mesTextEl = document.querySelector(`.mes[mesid="${msgIndex}"] .mes_text`);
            if (mesTextEl && mesTextEl.innerHTML.includes('&lt;karma&gt;') || (mesTextEl && mesTextEl.textContent.includes('<karma>'))) {
                mesTextEl.innerHTML = mesTextEl.innerHTML.replace(/&lt;karma&gt;[\s\S]*?&lt;\/karma&gt;/gi, '').replace(/<karma>[\s\S]*?<\/karma>/gi, '');
            }
        }
    }

    // 如果是 quiet 模式，或者 hybrid 模式下模型忘了输出 <karma> 标签且到达了判定间隔，则调用后台 AI 判定
    const shouldRunQuiet =
        settings.judgeMode === 'quiet' ||
        (settings.judgeMode === 'hybrid' && recordedSeeds.length === 0);

    if (shouldRunQuiet && ledger.turnCounter % Math.max(1, Number(settings.judgeInterval || 1)) === 0) {
        const quietSeeds = await judgeLatestTurnWithAI(false);
        recordedSeeds.push(...quietSeeds);
    }

    // 为记录的 seed 补充角色名引用以便 UI 展示
    for (const [charName, charRec] of Object.entries(ledger.characters)) {
        for (const s of (charRec.seeds || [])) {
            if (!s.character) s.character = charName;
        }
    }

    // 3. 运转【天道轮盘 · 延时清算检定】
    const triggeredSettlements = rollKarmaRouletteForAll();

    if (triggeredSettlements.length > 0 && typeof toastr !== 'undefined') {
        for (const t of triggeredSettlements) {
            const title = t.direction === 'retribution' ? '⚡ 天道轮盘命中 · 恶报将至' : '✨ 天道轮盘命中 · 福报将至';
            toastr.warning(
                `角色【${t.character}】触发【${t.severityName}】（触发率 ${t.triggerChance}%），将在下一回合剧情中清算旧账！`,
                title,
                { timeOut: 6000 }
            );
        }
    }

    // 4. 保存账本并同步下一回合的 Extension Prompts
    await saveChatLedger();
    syncExtensionPrompts();
    renderMessageKarmaBadge(msgIndex, recordedSeeds, triggeredSettlements);
    updateFabBadge();
    renderModalIfOpen();
}

/**
 * HTML 转义工具函数
 */
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 更新右下角太极悬浮球状态与角标
 */
function updateFabBadge() {
    const fab = document.getElementById('st-karma-fab');
    if (!fab) return;

    const settings = getSettings();
    fab.style.display = settings.showFab && settings.enabled ? 'flex' : 'none';

    const ledger = getChatLedger();
    const pendingCount = Array.isArray(ledger.pendingSettlements) ? ledger.pendingSettlements.length : 0;

    fab.classList.toggle('karma-fab-pending', pendingCount > 0);
    const badgeEl = fab.querySelector('.karma-fab-badge');
    if (badgeEl) {
        if (pendingCount > 0) {
            badgeEl.style.display = 'flex';
            badgeEl.textContent = String(pendingCount);
        } else {
            badgeEl.style.display = 'none';
        }
    }
}

/**
 * 打开【生死簿 · 天道因果账本】主面板
 */
function openKarmaModal() {
    const backdrop = document.getElementById('st-karma-modal-backdrop');
    if (!backdrop) return;
    backdrop.classList.add('karma-open');
    renderKarmaModalContent();
}

/**
 * 关闭【生死簿 · 天道因果账本】主面板
 */
function closeKarmaModal() {
    const backdrop = document.getElementById('st-karma-modal-backdrop');
    if (!backdrop) return;
    backdrop.classList.remove('karma-open');
}

function renderModalIfOpen() {
    const backdrop = document.getElementById('st-karma-modal-backdrop');
    if (backdrop && backdrop.classList.contains('karma-open')) {
        renderKarmaModalContent();
    }
}

/**
 * 渲染生死簿 Modal 内部完整视图
 */
function renderKarmaModalContent() {
    const bodyEl = document.getElementById('st-karma-modal-body');
    if (!bodyEl) return;

    const settings = getSettings();
    const ledger = getChatLedger();
    const currentTurn = ledger.turnCounter || 0;
    const chars = Object.values(ledger.characters);

    // 刷新所有角色最新的轮盘概率
    const charRoulettes = {};
    for (const c of chars) {
        charRoulettes[c.name] = calculateCharacterRoulette(c, currentTurn);
    }

    // 1. 顶部待触发天道指令横幅
    let pendingHtml = '';
    if (ledger.pendingSettlements && ledger.pendingSettlements.length > 0) {
        const itemsHtml = ledger.pendingSettlements.map(p => {
            const typeBadge = p.direction === 'retribution' ? '⚡ 恶报清算' : '✨ 福报兑现';
            return `<div style="margin-top:6px; display:flex; align-items:center; justify-content:space-between; gap:8px;">
                <div>
                    <strong>${typeBadge} · 【${escapeHtml(p.character)}】（${escapeHtml(p.severityName)}）</strong><br/>
                    <span style="font-size:11.5px; color:#d1d5db;">清算旧账：${escapeHtml(p.deedsText)}</span>
                </div>
                <button class="st-karma-btn karma-btn-danger st-karma-cancel-pending" data-id="${escapeHtml(p.id)}">撤销此劫</button>
            </div>`;
        }).join('');

        pendingHtml = `<div class="st-karma-pending-directive">
            <div style="font-weight:700; color:#f0abfc;">☯ 天道轮盘已锁定！以下因果清算指令将在【下一轮回复】中自动注入生效：</div>
            ${itemsHtml}
        </div>`;
    }

    // 2. 角色因果卡片列表
    let cardsHtml = '';
    if (chars.length === 0) {
        cardsHtml = `<div style="padding:28px; text-align:center; color:var(--karma-text-muted); border:1px dashed rgba(255,255,255,0.12); border-radius:10px;">
            当前对话尚无角色因果记录。<br/>
            你可以直接开始对话，或点击上方 <strong>“🔍 扫描世界书与背景宿命”</strong> 自动提取角色初始因果，也可以在下方手动添加。
        </div>`;
    } else {
        cardsHtml = `<div class="st-karma-char-grid">${chars.map(c => {
            const r = charRoulettes[c.name];
            const tier = getKarmaTierInfo(c.totalKarma);
            const scoreSign = c.totalKarma > 0 ? `+${c.totalKarma}` : `${c.totalKarma}`;
            const tagClass = c.totalKarma >= 15 ? 'tag-good' : (c.totalKarma <= -15 ? 'tag-evil' : 'tag-neutral');
            const cardAlertClass = r.triggerChance >= 50
                ? (r.dominantType === 'retribution' ? 'karma-card-evil-alert' : 'karma-card-good-alert')
                : '';

            // 计量条宽度 (以 100 为满格)
            const goodWidth = c.totalKarma > 0 ? Math.min(50, Math.round((c.totalKarma / 100) * 50)) : 0;
            const evilWidth = c.totalKarma < 0 ? Math.min(50, Math.round((Math.abs(c.totalKarma) / 100) * 50)) : 0;

            const unsettledSeeds = (c.seeds || []).slice().reverse().slice(0, 8);
            const seedsHtml = unsettledSeeds.length === 0
                ? `<div style="font-size:11px; color:var(--karma-text-muted);">暂无因果引子记录</div>`
                : unsettledSeeds.map(s => {
                    const rem = s.remainingDelta !== undefined ? s.remainingDelta : s.delta;
                    const deltaSign = s.delta > 0 ? `+${s.delta}` : `${s.delta}`;
                    const deltaCls = s.delta > 0 ? 'delta-good' : 'delta-evil';
                    const waited = Math.max(0, currentTurn - (s.turn || 0));
                    const reqWait = s.minDelayTurns !== undefined ? s.minDelayTurns : settings.latentTurns;
                    const statusLabel = s.settled
                        ? '已清算'
                        : (waited >= reqWait ? '🔥已成熟待报' : `⏳潜伏中(${waited}/${reqWait}回合)`);

                    return `<div class="st-karma-seed-item ${s.settled ? 'seed-settled' : ''}">
                        <div>
                            <span style="color:var(--karma-gold-soft);">[T${s.turn || 0}]</span>
                            ${escapeHtml(s.deed)}
                            ${s.ruleRef ? `<span style="color:#9ca3af;">(${escapeHtml(s.ruleRef)})</span>` : ''}
                            <span style="font-size:10.5px; color:#c084fc; margin-left:4px;">[${statusLabel}]</span>
                        </div>
                        <span class="st-karma-seed-delta ${deltaCls}">${deltaSign}</span>
                    </div>`;
                }).join('');

            const rouletteStatusText = r.inCooldown
                ? `冷却期中（还需 ${r.cooldownRemaining} 回合）`
                : (r.triggerChance > 0
                    ? `🎲 下回合触发率：<strong>${r.triggerChance}%</strong>（${r.dominantType === 'retribution' ? '恶报' : '福报'}池 ${r.dominantValue} 点）`
                    : `未达清算阈值（成熟恶业 ${r.matureEvil} / 善功 ${r.matureGood}，潜伏恶业 ${r.latentEvil} / 善功 ${r.latentGood}）`);

            return `<div class="st-karma-char-card ${cardAlertClass}">
                <div class="st-karma-char-header">
                    <div class="st-karma-char-name">
                        <span>👤 ${escapeHtml(c.name)}</span>
                        <span class="st-karma-tag ${tagClass}">${escapeHtml(tier.title)} (${scoreSign})</span>
                    </div>
                    <button class="st-karma-btn st-karma-delete-char" data-char="${escapeHtml(c.name)}" title="删除该角色档案" style="padding:2px 6px; font-size:11px;">✕</button>
                </div>

                <div class="st-karma-meter-wrap">
                    <div class="st-karma-meter-labels">
                        <span>💀 累计恶业: ${c.evilAccumulated || 0}</span>
                        <span>${escapeHtml(tier.aura)}</span>
                        <span>✨ 累计善功: ${c.goodAccumulated || 0}</span>
                    </div>
                    <div class="st-karma-meter-track">
                        <div class="st-karma-meter-center"></div>
                        <div class="st-karma-meter-fill-evil" style="width:${evilWidth}%;"></div>
                        <div class="st-karma-meter-fill-good" style="width:${goodWidth}%;"></div>
                    </div>
                </div>

                <div class="st-karma-roulette-box">
                    <span>☯ 天道轮盘：${rouletteStatusText}</span>
                </div>

                <div style="font-size:11.5px; font-weight:600; color:var(--karma-gold-soft);">📜 因果引子（不是不报，时候未到）：</div>
                <div class="st-karma-seeds-list">${seedsHtml}</div>

                <div class="st-karma-btn-bar" style="justify-content:flex-end; margin-top:auto;">
                    <button class="st-karma-btn karma-btn-danger st-karma-force-retribution" data-char="${escapeHtml(c.name)}">⚡ 立即降下恶报</button>
                    <button class="st-karma-btn karma-btn-good st-karma-force-blessing" data-char="${escapeHtml(c.name)}">✨ 立即赐予福报</button>
                </div>
            </div>`;
        }).join('')}</div>`;
    }

    // 3. 手动记账栏 & 历史日志
    const logsHtml = (ledger.historyLogs || []).slice(0, 15).map(log => {
        if (log.type === 'settlement') {
            const label = log.direction === 'retribution' ? '⚡【天道清算·恶报】' : '✨【天道清算·福报】';
            return `<div class="st-karma-log-entry log-retribution">
                <div><strong>[T${log.turn}] ${label} ${escapeHtml(log.character)}</strong>（${escapeHtml(log.severityName)}）：${escapeHtml(log.deedsText)}</div>
                <span style="color:var(--karma-text-muted); white-space:nowrap;">${escapeHtml(log.timestamp || '')}</span>
            </div>`;
        }
        const sign = log.delta > 0 ? `+${log.delta}` : `${log.delta}`;
        const color = log.delta > 0 ? 'var(--karma-good)' : 'var(--karma-evil)';
        return `<div class="st-karma-log-entry">
            <div>
                <strong>[T${log.turn}] ${escapeHtml(log.character)}</strong>：${escapeHtml(log.deed)}
                ${log.ruleRef ? `<span style="color:#9ca3af;">（${escapeHtml(log.ruleRef)}）</span>` : ''}
            </div>
            <span style="color:${color}; font-weight:700; white-space:nowrap;">${sign}</span>
        </div>`;
    }).join('') || '<div style="font-size:12px; color:var(--karma-text-muted);">暂无历史记录</div>';

    bodyEl.innerHTML = `
        <div class="st-karma-status-banner">
            <div>
                <strong>⏳ 当前对话天道纪年：第 ${currentTurn} 回合</strong>
                <span style="font-size:12px; color:var(--karma-text-muted); margin-left:10px;">
                    （潜伏期：${settings.latentTurns} 回合 | 轮盘阈值：±${settings.triggerThreshold} | 判定模式：${
                        settings.judgeMode === 'hybrid' ? '混合智能判定' : (settings.judgeMode === 'inline' ? '正文内嵌标签' : '后台静默API')
                    }）
                </span>
            </div>
            <div class="st-karma-btn-bar" style="margin:0;">
                <button id="st-karma-btn-scan-lore" class="st-karma-btn karma-btn-primary">🔍 扫描世界书与背景宿命</button>
                <button id="st-karma-btn-judge-now" class="st-karma-btn">⚖️ 立即判定最新回合</button>
                <button id="st-karma-btn-roll-now" class="st-karma-btn">🎲 手动转动天道轮盘</button>
                <button id="st-karma-btn-reset-chat" class="st-karma-btn karma-btn-danger">🗑️ 重置本局因果</button>
            </div>
        </div>

        ${pendingHtml}

        ${cardsHtml}

        <div class="st-karma-section-title">✍️ 手动记一笔因果（自定义角色或事件）</div>
        <div class="st-karma-manual-form">
            <input id="st-karma-manual-char" type="text" placeholder="角色姓名 (如: 萧炎)" style="width:130px;" />
            <input id="st-karma-manual-delta" type="number" value="-25" step="5" title="正数为善功，负数为恶业" style="width:85px;" />
            <input id="st-karma-manual-deed" type="text" placeholder="所作所为 (如: 暗中杀人夺宝 / 舍身救人)" style="flex:1; min-width:180px;" />
            <input id="st-karma-manual-rule" type="text" placeholder="关联法则/备注 (选填)" style="width:140px;" />
            <input id="st-karma-manual-delay" type="number" value="${settings.latentTurns}" min="0" max="20" title="潜伏回合数" style="width:70px;" />
            <button id="st-karma-manual-add-btn" class="st-karma-btn karma-btn-primary">➕ 记入生死簿</button>
        </div>

        <div class="st-karma-section-title">📜 天道因果流水录</div>
        <div class="st-karma-log-list">${logsHtml}</div>
    `;

    bindModalInnerEvents();
}

/**
 * 绑定 Modal 内部动态生成的按钮事件
 */
function bindModalInnerEvents() {
    const bodyEl = document.getElementById('st-karma-modal-body');
    if (!bodyEl) return;

    // 扫描世界书与角色背景
    bodyEl.querySelector('#st-karma-btn-scan-lore')?.addEventListener('click', async () => {
        await scanWorldLoreForInitialKarma();
    });

    // 立即判定最新回合
    bodyEl.querySelector('#st-karma-btn-judge-now')?.addEventListener('click', async () => {
        await judgeLatestTurnWithAI(true);
        const ledger = getChatLedger();
        for (const c of Object.values(ledger.characters)) {
            calculateCharacterRoulette(c, ledger.turnCounter);
        }
        await saveChatLedger();
        syncExtensionPrompts();
        renderKarmaModalContent();
        updateFabBadge();
    });

    // 手动转动天道轮盘
    bodyEl.querySelector('#st-karma-btn-roll-now')?.addEventListener('click', async () => {
        const triggered = rollKarmaRouletteForAll();
        await saveChatLedger();
        syncExtensionPrompts();
        renderKarmaModalContent();
        updateFabBadge();
        if (typeof toastr !== 'undefined') {
            if (triggered.length > 0) {
                toastr.warning(`天道轮盘命中 ${triggered.length} 位角色！将在下一回合降下因果。`, '🎲 天道轮盘');
            } else {
                toastr.info('本轮天道轮盘未命中任何角色（时候未到或概率未触发）。', '🎲 天道轮盘');
            }
        }
    });

    // 重置本局因果
    bodyEl.querySelector('#st-karma-btn-reset-chat')?.addEventListener('click', async () => {
        if (!confirm('确定要清空当前聊天的所有角色因果账本与历史记录吗？')) return;
        const ctx = getSTContext();
        ctx.chatMetadata[MODULE_NAME] = createEmptyLedger();
        await saveChatLedger();
        syncExtensionPrompts();
        renderKarmaModalContent();
        updateFabBadge();
    });

    // 手动添加因果记录
    bodyEl.querySelector('#st-karma-manual-add-btn')?.addEventListener('click', async () => {
        const charName = bodyEl.querySelector('#st-karma-manual-char')?.value?.trim();
        const delta = Number(bodyEl.querySelector('#st-karma-manual-delta')?.value || 0);
        const deed = bodyEl.querySelector('#st-karma-manual-deed')?.value?.trim();
        const ruleRef = bodyEl.querySelector('#st-karma-manual-rule')?.value?.trim();
        const minDelayTurns = Number(bodyEl.querySelector('#st-karma-manual-delay')?.value ?? 3);

        if (!charName || !delta) {
            if (typeof toastr !== 'undefined') toastr.warning('请填写角色姓名与非零的因果增减值。');
            return;
        }
        recordKarmaEvent(charName, delta, deed || (delta > 0 ? '手动记录善举' : '手动记录恶行'), {
            ruleRef,
            minDelayTurns,
        });
        await saveChatLedger();
        syncExtensionPrompts();
        renderKarmaModalContent();
        updateFabBadge();
    });

    // 撤销待执行的清算指令
    bodyEl.querySelectorAll('.st-karma-cancel-pending').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const ledger = getChatLedger();
            ledger.pendingSettlements = (ledger.pendingSettlements || []).filter(p => p.id !== id);
            await saveChatLedger();
            syncExtensionPrompts();
            renderKarmaModalContent();
            updateFabBadge();
        });
    });

    // 删除角色
    bodyEl.querySelectorAll('.st-karma-delete-char').forEach(btn => {
        btn.addEventListener('click', async () => {
            const charName = btn.getAttribute('data-char');
            if (!charName) return;
            const ledger = getChatLedger();
            delete ledger.characters[charName];
            ledger.pendingSettlements = (ledger.pendingSettlements || []).filter(p => p.character !== charName);
            await saveChatLedger();
            syncExtensionPrompts();
            renderKarmaModalContent();
            updateFabBadge();
        });
    });

    // 强制立即降下恶报 / 赐予福报
    const handleForceTrigger = async (charName, forcedDirection) => {
        const ledger = getChatLedger();
        const charRec = ledger.characters[charName];
        if (!charRec) return;

        const roulette = calculateCharacterRoulette(charRec, ledger.turnCounter);
        roulette.dominantType = forcedDirection;
        if (roulette.dominantValue < 25) {
            roulette.dominantValue = Math.max(35, Math.abs(charRec.totalKarma));
        }

        const directive = buildSettlementDirective(charRec, roulette, 1, true);
        directive.direction = forcedDirection;
        // 替换该角色已有的待清算指令
        ledger.pendingSettlements = (ledger.pendingSettlements || []).filter(p => p.character !== charName);
        ledger.pendingSettlements.push(directive);

        await saveChatLedger();
        syncExtensionPrompts();
        renderKarmaModalContent();
        updateFabBadge();

        if (typeof toastr !== 'undefined') {
            toastr.success(
                `已为【${charName}】锁定${forcedDirection === 'retribution' ? '天道恶报' : '天道福报'}，将在下一轮回复中生效！`,
                '☯ 天道法旨已下达'
            );
        }
    };

    bodyEl.querySelectorAll('.st-karma-force-retribution').forEach(btn => {
        btn.addEventListener('click', () => handleForceTrigger(btn.getAttribute('data-char'), 'retribution'));
    });

    bodyEl.querySelectorAll('.st-karma-force-blessing').forEach(btn => {
        btn.addEventListener('click', () => handleForceTrigger(btn.getAttribute('data-char'), 'blessing'));
    });
}

/**
 * 初始化插件 UI（右侧扩展抽屉设置面板 + 悬浮太极按钮 + 生死簿弹窗）
 */
function initUI() {
    const settings = getSettings();

    // 1. 注入扩展设置面板到 #extensions_settings2 或 #extensions_settings
    const settingsContainer = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (settingsContainer && !document.getElementById('st-karma-settings-drawer')) {
        const drawerHtml = `
        <div id="st-karma-settings-drawer" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>☯ 天道因果循环 (Karma Cycle)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="st-karma-settings-wrap">
                    <div class="st-karma-btn-bar">
                        <button id="st-karma-open-modal-btn" class="st-karma-btn karma-btn-primary" style="width:100%; justify-content:center; padding:7px;">
                            📖 打开【生死簿 · 天道因果账本】面板
                        </button>
                    </div>

                    <div class="st-karma-row">
                        <label><input id="st-karma-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} /> 启用天道因果循环系统</label>
                    </div>
                    <div class="st-karma-row">
                        <label><input id="st-karma-show-fab" type="checkbox" ${settings.showFab ? 'checked' : ''} /> 显示右下角 ☯ 悬浮球</label>
                    </div>
                    <div class="st-karma-row">
                        <label><input id="st-karma-show-badge" type="checkbox" ${settings.showChatBadge ? 'checked' : ''} /> 在聊天气泡底部显示天道记账提示条</label>
                    </div>

                    <div class="st-karma-section-title">⚖️ 善恶识别与世界书判定机制</div>
                    <div class="st-karma-row">
                        <label>因果判定模式</label>
                        <select id="st-karma-judge-mode" class="text_pole" style="width:185px;">
                            <option value="hybrid" ${settings.judgeMode === 'hybrid' ? 'selected' : ''}>混合模式 (优先标签/兜底后台)</option>
                            <option value="inline" ${settings.judgeMode === 'inline' ? 'selected' : ''}>仅正文内嵌 &lt;karma&gt; 标签 (零消耗)</option>
                            <option value="quiet" ${settings.judgeMode === 'quiet' ? 'selected' : ''}>仅后台静默 API 独立判定</option>
                        </select>
                    </div>
                    <div class="st-karma-row">
                        <label><input id="st-karma-include-wi" type="checkbox" ${settings.includeWorldInfo ? 'checked' : ''} /> 结合世界书(World Info)与角色卡判定</label>
                    </div>
                    <div class="st-karma-row">
                        <label>世界书法则提取关键词</label>
                        <input id="st-karma-wi-keywords" type="text" class="text_pole" value="${escapeHtml(settings.worldInfoKeywords)}" placeholder="因果,天道,禁忌,门规..." />
                    </div>
                    <div class="st-karma-row">
                        <label>后台静默判定间隔 (回合)</label>
                        <input id="st-karma-judge-interval" type="number" min="1" max="10" class="text_pole st-karma-input-num" value="${settings.judgeInterval}" />
                    </div>

                    <div class="st-karma-section-title">🎲 天道轮盘 · 延时清算参数 ("不是不报时候未到")</div>
                    <div class="st-karma-row">
                        <label title="结下因果后至少潜伏多少回合才进入轮盘清算池">因果潜伏期 (回合)</label>
                        <input id="st-karma-latent-turns" type="number" min="0" max="20" class="text_pole st-karma-input-num" value="${settings.latentTurns}" />
                    </div>
                    <div class="st-karma-row">
                        <label title="成熟未结因果绝对值达到多少点开始转动天道轮盘">轮盘起转阈值 (因果点)</label>
                        <input id="st-karma-threshold" type="number" min="5" max="200" step="5" class="text_pole st-karma-input-num" value="${settings.triggerThreshold}" />
                    </div>
                    <div class="st-karma-row">
                        <label title="刚达阈值时的基础触发概率 (%)">达标基础触发率 (%)</label>
                        <input id="st-karma-base-chance" type="number" min="1" max="100" class="text_pole st-karma-input-num" value="${settings.baseTriggerChance}" />
                    </div>
                    <div class="st-karma-row">
                        <label title="每多拖延1回合额外增加的轮盘触发概率 (%)">每回合递增触发率 (%)</label>
                        <input id="st-karma-turn-weight" type="number" min="0" max="50" class="text_pole st-karma-input-num" value="${settings.turnWeight}" />
                    </div>
                    <div class="st-karma-row">
                        <label title="两次报应/福报之间的最短冷却回合">报应冷却期 (回合)</label>
                        <input id="st-karma-cooldown" type="number" min="0" max="20" class="text_pole st-karma-input-num" value="${settings.cooldownTurns}" />
                    </div>
                    <div class="st-karma-row">
                        <label title="导演指令注入深度 (@D)">天道指令注入深度 (@D)</label>
                        <input id="st-karma-inject-depth" type="number" min="0" max="10" class="text_pole st-karma-input-num" value="${settings.injectDepth}" />
                    </div>

                    <div class="st-karma-section-title">🔌 独立副模型 API (可选，用于后台判定)</div>
                    <div class="st-karma-row">
                        <label><input id="st-karma-custom-api" type="checkbox" ${settings.useCustomApi ? 'checked' : ''} /> 启用独立 OpenAI 兼容 API 担任天道判官</label>
                    </div>
                    <div id="st-karma-custom-api-box" style="display:${settings.useCustomApi ? 'flex' : 'none'}; flex-direction:column; gap:6px;">
                        <input id="st-karma-api-url" type="text" class="text_pole" placeholder="API 地址 (如 https://api.openai.com/v1)" value="${escapeHtml(settings.customApiUrl)}" />
                        <input id="st-karma-api-key" type="password" class="text_pole" placeholder="API Key (sk-...)" value="${escapeHtml(settings.customApiKey)}" />
                        <input id="st-karma-api-model" type="text" class="text_pole" placeholder="模型名称 (如 gpt-4o-mini / deepseek-chat)" value="${escapeHtml(settings.customApiModel)}" />
                    </div>
                </div>
            </div>
        </div>`;

        settingsContainer.insertAdjacentHTML('beforeend', drawerHtml);
        bindSettingsEvents();
    }

    // 2. 创建右下角太极悬浮球
    if (!document.getElementById('st-karma-fab')) {
        const fab = document.createElement('div');
        fab.id = 'st-karma-fab';
        fab.title = '打开【生死簿 · 天道因果账本】';
        fab.innerHTML = `☯<span class="karma-fab-badge" style="display:none;">0</span>`;
        fab.addEventListener('click', openKarmaModal);
        document.body.appendChild(fab);
    }

    // 3. 创建生死簿 Modal 容器
    if (!document.getElementById('st-karma-modal-backdrop')) {
        const modalBackdrop = document.createElement('div');
        modalBackdrop.id = 'st-karma-modal-backdrop';
        modalBackdrop.innerHTML = `
            <div class="st-karma-modal">
                <div class="st-karma-modal-header">
                    <div>
                        <div class="st-karma-modal-title">☯ 生死簿 · 天道因果轮盘</div>
                        <div class="st-karma-modal-subtitle">“善恶终有报，天道好轮回。不是不报，时候未到。”</div>
                    </div>
                    <button id="st-karma-modal-close" class="st-karma-btn">✕ 关闭</button>
                </div>
                <div id="st-karma-modal-body" class="st-karma-modal-body"></div>
            </div>
        `;
        modalBackdrop.addEventListener('click', (e) => {
            if (e.target === modalBackdrop) closeKarmaModal();
        });
        document.body.appendChild(modalBackdrop);
        document.getElementById('st-karma-modal-close')?.addEventListener('click', closeKarmaModal);
    }

    updateFabBadge();
}

/**
 * 绑定设置抽屉控件事件
 */
function bindSettingsEvents() {
    const settings = getSettings();

    document.getElementById('st-karma-open-modal-btn')?.addEventListener('click', openKarmaModal);

    const bindCheck = (id, key) => {
        document.getElementById(id)?.addEventListener('change', (e) => {
            settings[key] = Boolean(e.target.checked);
            saveSettings();
            syncExtensionPrompts();
            updateFabBadge();
            if (key === 'useCustomApi') {
                const box = document.getElementById('st-karma-custom-api-box');
                if (box) box.style.display = settings.useCustomApi ? 'flex' : 'none';
            }
        });
    };

    const bindVal = (id, key, isNum = false) => {
        document.getElementById(id)?.addEventListener('change', (e) => {
            settings[key] = isNum ? Number(e.target.value) : String(e.target.value).trim();
            saveSettings();
            syncExtensionPrompts();
        });
    };

    bindCheck('st-karma-enabled', 'enabled');
    bindCheck('st-karma-show-fab', 'showFab');
    bindCheck('st-karma-show-badge', 'showChatBadge');
    bindCheck('st-karma-include-wi', 'includeWorldInfo');
    bindCheck('st-karma-custom-api', 'useCustomApi');

    bindVal('st-karma-judge-mode', 'judgeMode', false);
    bindVal('st-karma-wi-keywords', 'worldInfoKeywords', false);
    bindVal('st-karma-judge-interval', 'judgeInterval', true);
    bindVal('st-karma-latent-turns', 'latentTurns', true);
    bindVal('st-karma-threshold', 'triggerThreshold', true);
    bindVal('st-karma-base-chance', 'baseTriggerChance', true);
    bindVal('st-karma-turn-weight', 'turnWeight', true);
    bindVal('st-karma-cooldown', 'cooldownTurns', true);
    bindVal('st-karma-inject-depth', 'injectDepth', true);

    bindVal('st-karma-api-url', 'customApiUrl', false);
    bindVal('st-karma-api-key', 'customApiKey', false);
    bindVal('st-karma-api-model', 'customApiModel', false);
}

/**
 * 插件入口初始化
 */
jQuery(async () => {
    try {
        initUI();
        syncExtensionPrompts();

        const ctx = getSTContext();
        const evSource = ctx.eventSource;
        const evTypes = ctx.event_types || {};

        if (evSource && typeof evSource.on === 'function') {
            // 切换聊天时刷新账本与提示词
            if (evTypes.CHAT_CHANGED) {
                evSource.on(evTypes.CHAT_CHANGED, () => {
                    syncExtensionPrompts();
                    updateFabBadge();
                    renderModalIfOpen();
                });
            }

            // 收到 AI 回复时触发因果判定与天道轮盘
            if (evTypes.MESSAGE_RECEIVED) {
                evSource.on(evTypes.MESSAGE_RECEIVED, async (messageId) => {
                    await onMessageReceived(messageId);
                });
            }

            // 生成前确保最新的天道清算指令已注入
            const beforeGenEvents = [
                evTypes.GENERATE_BEFORE_COMBINE_PROMPTS,
                evTypes.CHAT_COMPLETION_PROMPT_READY,
            ].filter(Boolean);

            for (const evName of beforeGenEvents) {
                evSource.on(evName, () => {
                    syncExtensionPrompts();
                });
            }
        }

        console.log('☯ [天道因果循环 (Karma Cycle)] 插件已加载完毕！');
    } catch (err) {
        console.error('☯ [天道因果循环 (Karma Cycle)] 初始化失败:', err);
    }
});
