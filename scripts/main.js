
const MODULE_ID = "pf2e-roll-range";

Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "damageRangeMode", {
        name: "Damage Range Display",
        hint: "IWR = Immunities, Weaknesses, and Resistances. Choose whether to show basic damage ranges, target-adjusted ranges, or both.",
        scope: "world",
        config: true,
        type: String,
        choices: {
            basic: "Basic Only",
            target: "Target IWR Only",
            both: "Both Basic and Target IWR"
        },
        default: "basic"
    });

    game.settings.register(MODULE_ID, "multipleTargets", {
        name: "Calculate IWR for Multiple Targets",
        hint: "Only unique damage statistics are shown. (Entities without relevant IWRs use the basic statistics and therefore do not receive a separate entry.) When disabled, multiple targets use the basic damage range.",
        scope: "world",
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register(MODULE_ID, "iwrVisibility", {
        name: "Applied IWR Visibility",
        hint: "Choose whether to display the immunities, weaknesses, and resistances applied to the damage calculation.",
        scope: "world",
        config: true,
        type: String,
        choices: {
            none: "Do Not Display",
            everyone: "Display to Everyone"
        },
        default: "none"
    });
});

function isDamageRoll(roll) {
    return Array.isArray(roll.instances) && roll.instances.length > 0;
}

function isPublicRoll(message) {
    return !message.blind &&
        !message.whisper?.length &&
        !message.flags?.core?.rollMode?.includes("selfroll") &&
        !message.flags?.core?.rollMode?.includes("gmroll") &&
        !message.flags?.core?.rollMode?.includes("blindroll");
}

function getTargetTokens() {
    const targets = Array.from(game.user.targets);
    const allowMultiple = game.settings.get(MODULE_ID, "multipleTargets");

    if (targets.length === 0) return [];
    if (targets.length > 1 && !allowMultiple) return [];

    return targets.filter(token => token.actor);
}

function getInstanceStatements(instance, message) {
    const statements = new Set(
        message.flags?.pf2e?.context?.options ?? []
    );

    for (const statement of instance.formalDescription ?? []) {
        statements.add(statement);
    }

    return statements;
}

function getMatchingEntries(entries, statements) {
    return entries.filter(entry => {
        try {
            return entry.test(statements);
        } catch {
            return false;
        }
    });
}

function getMatchingImmunity(actor, statements) {
    const immunities = actor?.system?.attributes?.immunities ?? [];

    return getMatchingEntries(immunities, statements)[0] ?? null;
}

function getMatchingResistance(actor, statements) {
    const resistances = actor?.system?.attributes?.resistances ?? [];
    const matching = getMatchingEntries(resistances, statements);

    matching.sort((a, b) =>
        (Number(b.value) || 0) - (Number(a.value) || 0)
    );

    return matching[0] ?? null;
}

function getMatchingWeakness(actor, statements, usedApplyOnceWeaknesses) {
    const weaknesses = actor?.system?.attributes?.weaknesses ?? [];

    const matching = getMatchingEntries(weaknesses, statements)
        .filter(weakness =>
            !weakness.applyOnce ||
            !usedApplyOnceWeaknesses.has(weakness)
        )
        .sort((a, b) =>
            (Number(b.value) || 0) - (Number(a.value) || 0)
        );

    const weakness = matching[0] ?? null;

    if (weakness?.applyOnce) {
        usedApplyOnceWeaknesses.add(weakness);
    }

    return weakness;
}

function calculateBasicRange(roll) {
    const instances = roll.instances.filter(
        instance => !instance.persistent
    );

    if (instances.length === 0) return null;

    const min = instances.reduce(
        (total, instance) => total + Number(instance.minimumValue),
        0
    );

    const average = instances.reduce(
        (total, instance) => total + Number(instance.expectedValue),
        0
    );

    const max = instances.reduce(
        (total, instance) => total + Number(instance.maximumValue),
        0
    );

    if (![min, average, max].every(Number.isFinite)) {
        return null;
    }

    return { min, average, max };
}

function buildDiceDistribution(dice) {
    let distribution = new Map([[0, 1]]);

    for (const die of dice) {
        const number = Number(die.number);
        const faces = Number(die.faces);

        if (
            !Number.isInteger(number) ||
            !Number.isInteger(faces) ||
            number < 1 ||
            faces < 1
        ) {
            return null;
        }

        for (let dieNumber = 0; dieNumber < number; dieNumber++) {
            const next = new Map();

            for (const [currentTotal, probability] of distribution) {
                for (let result = 1; result <= faces; result++) {
                    const newTotal = currentTotal + result;
                    const newProbability = probability / faces;

                    next.set(
                        newTotal,
                        (next.get(newTotal) ?? 0) + newProbability
                    );
                }
            }

            distribution = next;
        }
    }

    return distribution;
}

function calculateResistedInstance(instance, resistance) {
    if (resistance <= 0) {
        return {
            min: Number(instance.minimumValue),
            average: Number(instance.expectedValue),
            max: Number(instance.maximumValue)
        };
    }

    const dice = Array.from(instance.dice ?? []);
    const distribution = buildDiceDistribution(dice);

    if (!distribution) return null;

    const diceMinimum = dice.reduce(
        (total, die) => total + Number(die.number),
        0
    );

    const flatModifier =
        Number(instance.minimumValue) - diceMinimum;

    let min = Infinity;
    let max = -Infinity;
    let average = 0;

    for (const [diceTotal, probability] of distribution) {
        const rawDamage = diceTotal + flatModifier;
        const finalDamage = Math.max(0, rawDamage - resistance);

        min = Math.min(min, finalDamage);
        max = Math.max(max, finalDamage);
        average += finalDamage * probability;
    }

    if (![min, average, max].every(Number.isFinite)) {
        return null;
    }

    return { min, average, max };
}

function formatNumber(value) {
    if (Number.isInteger(value)) {
        return String(value);
    }

    return String(Math.round(value * 100) / 100);
}

function rangesMatch(first, second) {
    return first.min === second.min &&
        formatNumber(first.average) === formatNumber(second.average) &&
        first.max === second.max;
}

function describeIWR(entry, category) {
    const type = String(entry.type ?? "unknown")
        .replaceAll("-", " ");

    const name = type.replace(
        /\b\w/g,
        letter => letter.toUpperCase()
    );

    const value = Number(entry.value);

    if (category === "Immunity") {
        return `${name} Immunity`;
    }

    return `${name} ${category} ${Number.isFinite(value) ? value : 0}`;
}

function calculateTargetRange(roll, actor, message) {
    const instances = roll.instances.filter(
        instance => !instance.persistent
    );

    if (instances.length === 0) return null;

    const usedApplyOnceWeaknesses = new Set();
    const appliedIWR = new Set();

    let min = 0;
    let average = 0;
    let max = 0;

    for (const instance of instances) {
        const statements = getInstanceStatements(instance, message);

        const immunity = getMatchingImmunity(actor, statements);

        if (immunity) {
            appliedIWR.add(
                describeIWR(immunity, "Immunity")
            );
            continue;
        }

        const resistanceEntry = getMatchingResistance(
            actor,
            statements
        );

        const resistance = Number(resistanceEntry?.value) || 0;

        const weaknessEntry = getMatchingWeakness(
            actor,
            statements,
            usedApplyOnceWeaknesses
        );

        const weakness = Number(weaknessEntry?.value) || 0;

        const adjusted = calculateResistedInstance(
            instance,
            resistance
        );

        if (resistanceEntry && resistance > 0) {
            appliedIWR.add(
                describeIWR(resistanceEntry, "Resistance")
            );
        }

        if (weaknessEntry && weakness > 0) {
            appliedIWR.add(
                describeIWR(weaknessEntry, "Weakness")
            );
        }

        if (!adjusted) {
            min += Number(instance.minimumValue) + weakness;
            average += Number(instance.expectedValue) + weakness;
            max += Number(instance.maximumValue) + weakness;
            continue;
        }

        min += adjusted.min + weakness;
        average += adjusted.average + weakness;
        max += adjusted.max + weakness;
    }

    if (![min, average, max].every(Number.isFinite)) {
        return null;
    }

    return {
        min,
        average,
        max,
        appliedIWR: Array.from(appliedIWR)
    };
}

function getTargetName(token) {
    return token.name || token.actor?.name || "Unknown Creature";
}

function groupTargetRanges(roll, targets, message) {
    const groups = [];

    for (const token of targets) {
        const result = calculateTargetRange(
            roll,
            token.actor,
            message
        );

        if (!result) continue;

        let group = groups.find(existing =>
            rangesMatch(existing, result) &&
            existing.appliedIWR.length === result.appliedIWR.length &&
            existing.appliedIWR.every(
                iwr => result.appliedIWR.includes(iwr)
            )
        );

        if (!group) {
            group = {
                min: result.min,
                average: result.average,
                max: result.max,
                appliedIWR: result.appliedIWR,
                names: []
            };

            groups.push(group);
        }

        group.names.push(getTargetName(token));
    }

    return groups;
}

function formatTargetNames(names) {
    const counts = new Map();

    for (const name of names) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }

    return Array.from(counts, ([name, count]) =>
        count > 1 ? `${name} ×${count}` : name
    ).join(", ");
}

function buildRanges(roll, message, mode, targets, basicRange) {
    if (mode === "basic" || targets.length === 0) {
        return [{
            label: "",
            names: [],
            appliedIWR: [],
            ...basicRange
        }];
    }

    const ranges = [];
    const groups = groupTargetRanges(
        roll,
        targets,
        message
    );

    const hasMultipleTargets = targets.length > 1;

    if (mode === "both") {
        const basicGroups = groups.filter(group =>
            rangesMatch(group, basicRange) &&
            group.appliedIWR.length === 0
        );

        ranges.push({
            label: "Basic",
            names: hasMultipleTargets
                ? basicGroups.flatMap(group => group.names)
                : [],
            appliedIWR: [],
            ...basicRange
        });
    }

    for (const group of groups) {
        if (
            mode === "both" &&
            rangesMatch(group, basicRange) &&
            group.appliedIWR.length === 0
        ) {
            continue;
        }

        ranges.push({
            label: formatTargetNames(group.names),
            names: [],
            min: group.min,
            average: group.average,
            max: group.max,
            appliedIWR: group.appliedIWR
        });
    }

    if (ranges.length === 0) {
        ranges.push({
            label: "",
            names: [],
            appliedIWR: [],
            ...basicRange
        });
    }

    return ranges;
}

function createRangeElement(ranges, showIWR) {
    const container = document.createElement("div");
    container.classList.add("pf2e-roll-range");

    for (const range of ranges) {
        const section = document.createElement("div");
        section.classList.add("pf2e-roll-range-section");

        if (range.label) {
            const heading = document.createElement("div");
            heading.classList.add("pf2e-roll-range-heading");
            heading.textContent = range.label;
            section.appendChild(heading);
        }

        if (range.names?.length) {
            const names = document.createElement("div");
            names.classList.add("pf2e-roll-range-targets");
            names.textContent = formatTargetNames(range.names);
            section.appendChild(names);
        }

        const values = document.createElement("div");
        values.classList.add("pf2e-roll-range-values");

        for (const [label, value] of [
            ["Min", range.min],
            ["Average", range.average],
            ["Max", range.max]
        ]) {
            const column = document.createElement("div");
            column.classList.add("pf2e-roll-range-value");

            const labelElement = document.createElement("div");
            labelElement.classList.add("pf2e-roll-range-label");
            labelElement.textContent = label;

            const numberElement = document.createElement("div");
            numberElement.classList.add("pf2e-roll-range-number");
            numberElement.textContent = formatNumber(value);

            column.append(labelElement, numberElement);
            values.appendChild(column);
        }

        section.appendChild(values);

        if (showIWR && range.appliedIWR?.length) {
            const details = document.createElement("div");
            details.classList.add("pf2e-roll-range-iwr");
            details.textContent = range.appliedIWR.join(", ");
            section.appendChild(details);
        }

        container.appendChild(section);
    }

    return container;
}

Hooks.on("createChatMessage", async message => {
    if (!message.isAuthor) return;
    if (!message.rolls?.length) return;

    // Do not calculate or store ranges for nonpublic rolls.
    if (!isPublicRoll(message)) return;

    const roll = message.rolls[0];

    if (!isDamageRoll(roll)) return;

    const mode = game.settings.get(
        MODULE_ID,
        "damageRangeMode"
    );

    const visibility = game.settings.get(
        MODULE_ID,
        "iwrVisibility"
    );

    const basicRange = calculateBasicRange(roll);

    if (!basicRange) return;

    const targets = mode === "basic"
        ? []
        : getTargetTokens();

    const ranges = buildRanges(
        roll,
        message,
        mode,
        targets,
        basicRange
    );

    const publicRanges = ranges.map(range => ({
        label: range.label,
        names: range.names,
        min: range.min,
        average: range.average,
        max: range.max,
        appliedIWR: visibility === "everyone"
            ? range.appliedIWR
            : []
    }));

    await message.setFlag(
        MODULE_ID,
        "ranges",
        publicRanges
    );
});

Hooks.on("renderChatMessage", (message, html) => {
    // Never display our statistics on nonpublic rolls,
    // including older messages that may contain range flags.
    if (!isPublicRoll(message)) return;

    const ranges = message.getFlag(
        MODULE_ID,
        "ranges"
    );

    if (!ranges?.length) return;

    const root = html instanceof HTMLElement
        ? html
        : html?.[0];

    if (!root || root.querySelector(".pf2e-roll-range")) {
        return;
    }

    const visibility = game.settings.get(
        MODULE_ID,
        "iwrVisibility"
    );

    root.appendChild(
        createRangeElement(
            ranges,
            visibility === "everyone"
        )
    );
});
