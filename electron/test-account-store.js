const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { writeJsonAtomically } = require("../src/utils/detail-checkpoint");

const VERSION = 2;

function isStoredAccount(account) {
    if (!account || typeof account.key !== "string" || !account.key ||
        typeof account.id !== "string" || !account.id) return false;

    if (Object.hasOwn(account, "encryptedPw")) {
        return typeof account.encryptedPw === "string" && Boolean(account.encryptedPw) &&
            !Object.hasOwn(account, "pw");
    }

    return typeof account.pw === "string" && Boolean(account.pw);
}

/** 가입으로 확인된 계정은 비밀번호를 암호화해 기존 테스트 계정 파일에 보관한다. */
function createTestAccountStore(userDataPath, { safeStorage } = {}) {
    const filePath = path.join(userDataPath, "test-accounts.json");
    let queue = Promise.resolve();

    function enqueue(action) {
        const result = queue.then(action);
        queue = result.catch(() => {});
        return result;
    }

    function assertCanStoreRealAccount() {
        if (!safeStorage?.isEncryptionAvailable?.() ||
            typeof safeStorage.encryptString !== "function" ||
            typeof safeStorage.decryptString !== "function" ||
            (process.platform === "linux" && safeStorage.getSelectedStorageBackend?.() === "basic_text")) {
            throw new Error("운영체제 보안 저장소를 사용할 수 없어 가입 계정의 비밀번호를 보호할 수 없습니다.");
        }
    }

    function toAccount({ key, id, pw, encryptedPw }) {
        if (!encryptedPw) return { key, id, pw };
        assertCanStoreRealAccount();
        try {
            return { key, id, pw: safeStorage.decryptString(Buffer.from(encryptedPw, "base64")) };
        } catch {
            throw new Error("저장한 비밀번호를 복호화할 수 없습니다. 가입 계정을 저장한 운영체제 사용자로 실행하세요.");
        }
    }

    async function readAccounts() {
        let content;
        try {
            content = await fs.readFile(filePath, "utf8");
        } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
        }

        let data;
        try {
            data = JSON.parse(content);
        } catch {
            throw new Error("테스트 계정 파일을 읽을 수 없습니다.");
        }

        if (![1, VERSION].includes(data?.version) || !Array.isArray(data.accounts) ||
            !data.accounts.every(isStoredAccount)) {
            throw new Error("테스트 계정 파일 형식이 올바르지 않습니다.");
        }

        return data.accounts.map(({ key, id, pw, encryptedPw }) =>
            encryptedPw ? { key, id, encryptedPw } : { key, id, pw });
    }

    async function saveAccounts(accounts) {
        await writeJsonAtomically(filePath, { version: VERSION, accounts });
    }

    function list() {
        return enqueue(async () => (await readAccounts()).map(toAccount));
    }

    function add({ id, pw }, { encryptPassword = false } = {}) {
        return enqueue(async () => {
            if (typeof id !== "string" || !id.trim() || typeof pw !== "string" || !pw) {
                throw new Error("테스트 계정 ID와 비밀번호가 필요합니다.");
            }

            const accounts = await readAccounts();
            const loginId = id.trim();
            if (accounts.some((account) => account.id.toLowerCase() === loginId.toLowerCase())) {
                throw new Error("이미 등록된 테스트 계정 ID입니다.");
            }

            const account = { key: randomUUID(), id: loginId, pw };
            let stored = account;
            if (encryptPassword) {
                assertCanStoreRealAccount();
                try {
                    const encryptedPw = safeStorage.encryptString(pw).toString("base64");
                    stored = { key: account.key, id: account.id, encryptedPw };
                } catch {
                    throw new Error("가입 계정의 비밀번호를 암호화하지 못했습니다.");
                }
            }
            await saveAccounts([...accounts, stored]);
            return account;
        });
    }

    function remove(key) {
        return enqueue(async () => {
            const accounts = await readAccounts();
            const remaining = accounts.filter((account) => account.key !== key);
            const visibleAccounts = remaining.map(toAccount);
            if (remaining.length !== accounts.length) await saveAccounts(remaining);
            return visibleAccounts;
        });
    }

    return { list, add, remove, assertCanStoreRealAccount };
}

module.exports = { createTestAccountStore };
