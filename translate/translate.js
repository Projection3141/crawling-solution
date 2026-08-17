/** translate/translate.js */

const fs = require("node:fs/promises");
const path = require("node:path");
const OpenAI = require("openai");
const { zodTextFormat } = require("openai/helpers/zod");
const { z } = require("zod");
const { DEFAULT_OPENAI_MODEL } = require("../src/config");
const {
  ARCHIVE_PATH,
  archiveToTranslationItems,
  readProductArchive,
  updateProductArchive,
} = require("../src/utils/product-archive");

const BATCH_SIZE = 100;
const PARALLEL_REQUESTS = 10;
const MAX_RETRIES = 3;

const OUTPUT_FILE_NAME = "result_translated.json";

let translationQueue = Promise.resolve();

/** main process가 전달한 실행별 OpenAI 설정을 복사한다. */
function resolveOpenAiOptions(openAi) {
  const source = openAi && typeof openAi === "object" ? openAi : {};
  const apiKey = source.apiKey;
  const model = Object.hasOwn(source, "model")
    ? source.model
    : DEFAULT_OPENAI_MODEL;

  return Object.freeze({
    apiKey: String(apiKey || "").trim(),
    model: String(model || "").trim() || DEFAULT_OPENAI_MODEL,
  });
}

/** 현재 번역 실행에서만 사용할 OpenAI 클라이언트를 생성한다. */
function createOpenAIClient(apiKey) {
  if (!apiKey) {
    throw new Error("OpenAI API 키가 없습니다. 화면에서 등록한 API 키를 선택하세요.");
  }

  return new OpenAI({ apiKey });
}

const TranslationOption = z.object({
  id: z.string(),
  ja: z.string(),
  en: z.string(),
});

const TranslationProduct = z.object({
  key: z.string(),
  nameJa: z.string(),
  nameEn: z.string(),
  options: z.array(TranslationOption),
});

const TranslationBatchResult = z.object({
  items: z.array(TranslationProduct),
});

/** 지정 시간만큼 대기한다. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 배열을 지정한 크기로 나눈다. */
function chunk(items, size) {
  const result = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

/** 문자열을 공백 제거된 값으로 변환한다. */
function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/** 취소 요청이 있으면 번역 작업을 중단한다. */
function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }

  const error = new Error("번역 작업이 취소되었습니다.");
  error.name = "AbortError";
  throw error;
}

/** 재시도 가능한 OpenAI 요청 오류인지 확인한다. */
function isRetryableError(error) {
  const status = Number(error?.status || 0);

  return (
    [408, 409, 429, 500, 502, 503, 504].includes(status) ||
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(error?.code)
  );
}

/** 입력 JSON에서 번역할 상품 배열을 가져온다. */
function getInventoryItems(json) {
  if (Array.isArray(json)) {
    return json;
  }

  if (json && Array.isArray(json.inventoryItems)) {
    return json.inventoryItems;
  }

  if (json && Array.isArray(json.products)) {
    return json.products;
  }

  throw new Error(
    "입력 JSON은 상품 배열이거나 inventoryItems 또는 products 배열을 포함해야 합니다.",
  );
}

/**
 * 옵션별 수집 데이터 또는 백엔드 상품 데이터를 상품 단위로 묶는다.
 *
 * 지원 형식:
 * 1. 크롤링 row: productId, productName, optionId, optionText
 * 2. 백엔드 상품: id, nameKo, options: [{ id, name }]
 */
function groupInventoryItems(inventoryItems) {
  const productMap = new Map();
  const skippedOptions = [];

  /** 처리하지 못한 옵션을 기록하고 콘솔에 출력한다. */
  function skipOption(product, optionId, optionText, index, reason) {
    const skipped = {
      number: skippedOptions.length + 1,
      inputIndex: index + 1,
      productId: product.id,
      productName: product.nameKo,
      optionId,
      optionText,
      reason,
    };

    skippedOptions.push(skipped);

    console.warn(
      `[옵션 건너뜀 ${skipped.number}] ` +
        `${skipped.inputIndex}번째 입력 | ` +
        `상품 ${skipped.productId} (${skipped.productName}) | ` +
        `${reason}`,
    );
  }

  /** 상품을 생성하거나 기존 상품을 가져온다. */
  function getOrCreateProduct(productId, productName, index) {
    if (!productId) {
      throw new Error(`${index + 1}번째 상품의 productId 또는 id가 비어 있습니다.`);
    }

    if (!productName) {
      throw new Error(`${index + 1}번째 상품의 normalizedName 또는 nameKo가 비어 있습니다.`);
    }

    if (!productMap.has(productId)) {
      productMap.set(productId, {
        id: productId,
        nameKo: productName,
        options: new Map(),
      });
    }

    const product = productMap.get(productId);

    if (product.nameKo !== productName) {
      throw new Error(
        `동일 상품 ID에 서로 다른 normalizedName이 있습니다: ` +
          `${productId} / ${product.nameKo} / ${productName}`,
      );
    }

    return product;
  }

  /** 상품에 유효한 옵션만 중복 없이 추가한다. */
  function addOption(product, optionId, optionText, index) {
    if (!optionId) {
      skipOption(
        product,
        optionId,
        optionText,
        index,
        "옵션 ID가 비어 있어 번역 대상에서 제외했습니다.",
      );
      return;
    }

    if (optionId === "0") {
      skipOption(
        product,
        optionId,
        optionText,
        index,
        '옵션 ID가 "0"이어서 번역 대상에서 제외했습니다.',
      );
      return;
    }

    if (!optionText) {
      skipOption(
        product,
        optionId,
        optionText,
        index,
        "옵션명이 비어 있어 번역 대상에서 제외했습니다.",
      );
      return;
    }

    const existingOption = product.options.get(optionId);

    if (existingOption && existingOption.ko !== optionText) {
      skipOption(
        product,
        optionId,
        optionText,
        index,
        `동일 optionId에 기존 옵션명(${existingOption.ko})과 ` +
          `다른 옵션명이 있어 제외했습니다.`,
      );
      return;
    }

    product.options.set(optionId, {
      id: optionId,
      ko: optionText,
    });
  }

  for (let index = 0; index < inventoryItems.length; index += 1) {
    const item = inventoryItems[index];
    const productId = normalizeText(item?.productId || item?.id);
    const normalizedName = normalizeText(
      item?.normalizedName ||
        item?.nameKo ||
        item?.productName,
    );

    const product = getOrCreateProduct(
      productId,
      normalizedName,
      index,
    );

    /** 백엔드 상품 데이터의 중첩 options 배열을 처리한다. */
    if (Array.isArray(item?.options)) {
      for (const option of item.options) {
        const optionId = normalizeText(option?.id || option?.optionId);
        const optionText = normalizeText(
          option?.nameKo || option?.ko || option?.name || option?.optionText,
        );

        addOption(product, optionId, optionText, index);
      }

      continue;
    }

    /** 크롤링 결과의 옵션별 row를 처리한다. */
    const rawOptionId = normalizeText(item?.optionId);
    const rawOptionText = normalizeText(
      item?.optionText || item?.optionName || item?.name,
    );
    const hasOption =
      item?.hasOption === true ||
      (rawOptionId !== "" && rawOptionId !== "0" && rawOptionText !== "");

    if (hasOption) {
      addOption(product, rawOptionId, rawOptionText, index);
    }
  }

  if (skippedOptions.length > 0) {
    console.warn(
      `[옵션 건너뜀 합계] ${skippedOptions.length}개 옵션을 ` +
        "번역 대상에서 제외했습니다.",
    );
  }

  return {
    products: Array.from(productMap.values()).map((product) => ({
      id: product.id,
      nameKo: product.nameKo,
      options: Array.from(product.options.values()),
    })),
    skippedOptions,
  };
}

/** 통합 archive에서 번역에 필요한 상품명·옵션명만 읽는다. */
async function readArchive() {
  const archive = await readProductArchive();

  return archiveToTranslationItems(archive);
}

/**
 * 상세 수집에는 재고 row가 없을 수 있으므로 archive의 기존 옵션 원문을 보완한다.
 * 이렇게 해야 상세 수집에서도 기존 옵션의 누락된 일본어 번역만 추가할 수 있다.
 */
function mergeDetailProductsWithArchive(
  products,
  archive,
  collectionMode,
) {
  if (collectionMode !== "detail") {
    return products;
  }

  const archiveMap = new Map(
    archive.map((item) => [normalizeText(item?.id), item]),
  );

  return products.map((product) => {
    const archiveItem = archiveMap.get(product.id);
    const optionMap = new Map(
      (product.options || []).map((option) => [option.id, option]),
    );

    for (const option of archiveItem?.options || []) {
      const optionId = normalizeText(option?.id);
      const optionText = normalizeText(option?.ko);

      if (!optionId || !optionText || optionMap.has(optionId)) {
        continue;
      }

      optionMap.set(optionId, {
        id: optionId,
        ko: optionText,
      });
    }

    return {
      ...product,
      nameKo:
        normalizeText(product.nameKo) ||
        normalizeText(archiveItem?.nameKo),
      options: Array.from(optionMap.values()),
    };
  });
}

/** 수집 방식별로 실제 필요한 번역 언어를 반환한다. */
function getTranslationRequirements(collectionMode) {
  if (collectionMode === "detail") {
    return {
      productJa: true,
      productEn: true,
      optionJa: true,
      optionEn: false,
    };
  }

  return {
    productJa: true,
    productEn: true,
    optionJa: true,
    optionEn: true,
  };
}

/** 보관된 상품 번역이 현재 한글 상품명과 일치하는지 확인한다. */
function hasValidProductTranslation(
  archiveItem,
  product,
  requirements,
) {
  if (
    !archiveItem ||
    normalizeText(archiveItem.nameKo) !== product.nameKo
  ) {
    return false;
  }

  if (
    requirements.productJa &&
    normalizeText(archiveItem.nameJa) === ""
  ) {
    return false;
  }

  if (
    requirements.productEn &&
    normalizeText(archiveItem.nameEn) === ""
  ) {
    return false;
  }

  return true;
}

/** 보관된 옵션 번역이 현재 옵션명과 일치하는지 확인한다. */
function hasValidOptionTranslation(
  archiveOption,
  option,
  requirements,
) {
  if (
    !archiveOption ||
    normalizeText(archiveOption.ko) !== option.ko
  ) {
    return false;
  }

  if (
    requirements.optionJa &&
    normalizeText(archiveOption.ja) === ""
  ) {
    return false;
  }

  if (
    requirements.optionEn &&
    normalizeText(archiveOption.en) === ""
  ) {
    return false;
  }

  return true;
}

/** 아카이브를 확인해 실제 API 번역이 필요한 항목만 생성한다. */
function createTranslationTasks(
  products,
  archive,
  requirements,
) {
  const archiveMap = new Map(
    archive.map((item) => [normalizeText(item?.id), item]),
  );
  const tasks = [];

  for (const product of products) {
    const archiveItem = archiveMap.get(product.id);
    const sameProductName =
      archiveItem &&
      normalizeText(archiveItem.nameKo) === product.nameKo;
    const translateNameJa =
      requirements.productJa &&
      (!sameProductName || normalizeText(archiveItem?.nameJa) === "");
    const translateNameEn =
      requirements.productEn &&
      (!sameProductName || normalizeText(archiveItem?.nameEn) === "");
    const archiveOptionMap = new Map(
      Array.isArray(archiveItem?.options)
        ? archiveItem.options.map((option) => [normalizeText(option?.id), option])
        : [],
    );
    const missingOptions = [];

    for (const option of product.options) {
      const archiveOption = archiveOptionMap.get(option.id);
      const sameOptionName =
        archiveOption &&
        normalizeText(archiveOption.ko) === option.ko;
      const translateJa =
        requirements.optionJa &&
        (!sameOptionName || normalizeText(archiveOption?.ja) === "");
      const translateEn =
        requirements.optionEn &&
        (!sameOptionName || normalizeText(archiveOption?.en) === "");

      if (!translateJa && !translateEn) {
        continue;
      }

      missingOptions.push({
        ...option,
        translateJa,
        translateEn,
      });
    }

    if (
      !translateNameJa &&
      !translateNameEn &&
      missingOptions.length < 1
    ) {
      continue;
    }

    tasks.push({
      key: product.id,
      nameKo:
        translateNameJa || translateNameEn
          ? product.nameKo
          : "",
      translateNameJa,
      translateNameEn,
      options: missingOptions,
    });
  }

  return tasks;
}

/** 번역 배치 하나를 OpenAI에 요청한다. */
async function requestTranslationBatch(
  batch,
  batchNumber,
  { client, model, signal },
) {
  const requestItems = batch.map((item) => ({
    key: item.key,
    nameKo: item.nameKo,
    translateNameJa: item.translateNameJa,
    translateNameEn: item.translateNameEn,
    options: item.options.map((option) => ({
      id: option.id,
      ko: option.ko,
      translateJa: option.translateJa,
      translateEn: option.translateEn,
    })),
  }));

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      throwIfAborted(signal);

      const response = await client.responses.parse({
        model,
        store: false,
        input: [
          {
            role: "system",
            content: [
              "You are Luna, a Korean-to-Japanese and Korean-to-English ecommerce product translator.",
              "Each input item represents one product and all of its untranslated options.",
              "Translate nameKo into Japanese only when translateNameJa is true; otherwise return nameJa as an empty string.",
              "Translate nameKo into English only when translateNameEn is true; otherwise return nameEn as an empty string.",
              "For each option, translate ko into Japanese only when translateJa is true and into English only when translateEn is true.",
              "Return an empty string for every option language whose translate flag is false.",
              "Preserve key and every option id exactly.",
              "Preserve model numbers, dimensions, quantities, units, symbols, brand names, character names, and product codes.",
              "Do not omit, merge, reorder, summarize, or add products or options.",
              "Return exactly one output item for every input item and exactly one option result for every supplied option.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({
              items: requestItems,
            }),
          },
        ],
        text: {
          format: zodTextFormat(
            TranslationBatchResult,
            "grouped_product_translation_batch",
          ),
        },
      }, {
        signal,
      });

      const parsed = response.output_parsed;

      if (!parsed || !Array.isArray(parsed.items)) {
        throw new Error(`배치 ${batchNumber}의 번역 응답이 비어 있습니다.`);
      }

      if (parsed.items.length !== batch.length) {
        throw new Error(
          `배치 ${batchNumber} 응답 수가 일치하지 않습니다. ` +
          `요청 ${batch.length}개, 응답 ${parsed.items.length}개`,
        );
      }

      const resultByKey = new Map();

      for (const translatedItem of parsed.items) {
        if (resultByKey.has(translatedItem.key)) {
          throw new Error(
            `배치 ${batchNumber} 응답에 중복 key가 있습니다: ` +
            translatedItem.key,
          );
        }

        resultByKey.set(translatedItem.key, translatedItem);
      }

      return batch.map((item) => {
        const translatedItem = resultByKey.get(item.key);

        if (!translatedItem) {
          throw new Error(
            `배치 ${batchNumber} 응답에 key ${item.key}가 없습니다.`,
          );
        }

        const requestedOptionIds = new Set(
          item.options.map((option) => option.id),
        );
        const translatedOptionIds = new Set();

        for (const option of translatedItem.options) {
          if (translatedOptionIds.has(option.id)) {
            throw new Error(
              `배치 ${batchNumber}, 상품 ${item.key} 응답에 ` +
              `중복 option id가 있습니다: ${option.id}`,
            );
          }

          if (!requestedOptionIds.has(option.id)) {
            throw new Error(
              `배치 ${batchNumber}, 상품 ${item.key} 응답에 ` +
              `요청하지 않은 option id가 있습니다: ${option.id}`,
            );
          }

          translatedOptionIds.add(option.id);
        }

        if (translatedOptionIds.size !== requestedOptionIds.size) {
          throw new Error(
            `배치 ${batchNumber}, 상품 ${item.key}의 옵션 응답 수가 ` +
            `일치하지 않습니다. 요청 ${requestedOptionIds.size}개, ` +
            `응답 ${translatedOptionIds.size}개`,
          );
        }

        if (
          item.translateNameJa &&
          normalizeText(translatedItem.nameJa) === ""
        ) {
          throw new Error(
            `배치 ${batchNumber}, 상품 ${item.key}의 일본어 상품명이 비어 있습니다.`,
          );
        }

        if (
          item.translateNameEn &&
          normalizeText(translatedItem.nameEn) === ""
        ) {
          throw new Error(
            `배치 ${batchNumber}, 상품 ${item.key}의 영어 상품명이 비어 있습니다.`,
          );
        }

        const requestOptionMap = new Map(
          item.options.map((option) => [option.id, option]),
        );

        for (const option of translatedItem.options) {
          const requestOption = requestOptionMap.get(option.id);

          if (
            requestOption?.translateJa &&
            normalizeText(option.ja) === ""
          ) {
            throw new Error(
              `배치 ${batchNumber}, 상품 ${item.key}, 옵션 ${option.id}의 ` +
                "일본어 번역이 비어 있습니다.",
            );
          }

          if (
            requestOption?.translateEn &&
            normalizeText(option.en) === ""
          ) {
            throw new Error(
              `배치 ${batchNumber}, 상품 ${item.key}, 옵션 ${option.id}의 ` +
                "영어 번역이 비어 있습니다.",
            );
          }
        }

        return translatedItem;
      });
    } catch (error) {
      const canRetry = attempt < MAX_RETRIES && isRetryableError(error);

      if (!canRetry) {
        throw new Error(
          `배치 ${batchNumber} 번역 실패: ${error?.message || error}`,
        );
      }

      const delayMs = 1000 * 2 ** (attempt - 1);

      console.warn(
        `[재시도] 배치 ${batchNumber}, ` +
        `${attempt}/${MAX_RETRIES}, ` +
        `${delayMs}ms 후 재시도`,
      );

      await sleep(delayMs);
    }
  }

  throw new Error(`배치 ${batchNumber} 번역에 실패했습니다.`);
}

/** 상품 단위 배치를 최대 10개씩 병렬 처리한다. */
async function translateAllTasks(tasks, { signal, openAi } = {}) {
  throwIfAborted(signal);

  if (tasks.length < 1) {
    console.log("[번역 생략] 아카이브에 모든 번역이 존재합니다.");
    return [];
  }

  const client = createOpenAIClient(openAi.apiKey);
  const model = openAi.model;

  const batches = chunk(tasks, BATCH_SIZE);
  const waves = chunk(batches, PARALLEL_REQUESTS);
  const translatedItems = [];
  let completedProductCount = 0;

  console.log(`[시작] 신규 번역 상품 수: ${tasks.length}`);
  console.log(
    `[설정] 요청당 상품 ${BATCH_SIZE}개, 동시 요청 ${PARALLEL_REQUESTS}개`,
  );

  for (let waveIndex = 0; waveIndex < waves.length; waveIndex += 1) {
    throwIfAborted(signal);
    const wave = waves[waveIndex];
    const waveStartBatchIndex = waveIndex * PARALLEL_REQUESTS;
    const waveProductCount = wave.reduce(
      (sum, batch) => sum + batch.length,
      0,
    );
    const waveOptionCount = wave.reduce(
      (sum, batch) =>
        sum + batch.reduce((count, item) => count + item.options.length, 0),
      0,
    );

    console.log(
      `[진행] ${waveIndex + 1}/${waves.length}차 병렬 요청 시작 ` +
      `(상품 ${waveProductCount}개, 옵션 ${waveOptionCount}개)`,
    );

    const waveResults = await Promise.all(
      wave.map((batch, localBatchIndex) => {
        const batchNumber = waveStartBatchIndex + localBatchIndex + 1;

        return requestTranslationBatch(batch, batchNumber, {
          client,
          model,
          signal,
        });
      }),
    );

    for (const batchResult of waveResults) {
      translatedItems.push(...batchResult);
      completedProductCount += batchResult.length;
    }

    console.log(
      `[완료] ${completedProductCount}/${tasks.length}개 상품 번역 완료`,
    );
  }

  return translatedItems;
}

/** 신규 번역과 기존 아카이브를 합쳐 현재 입력 결과를 생성한다. */
function createCurrentResults(
  products,
  archive,
  translations,
  requirements,
) {
  const archiveMap = new Map(
    archive.map((item) => [normalizeText(item?.id), item]),
  );
  const translationMap = new Map(
    translations.map((item) => [normalizeText(item?.key), item]),
  );

  return products.map((product) => {
    const archiveItem = archiveMap.get(product.id);
    const translatedItem = translationMap.get(product.id);
    const sameProductName =
      archiveItem &&
      normalizeText(archiveItem.nameKo) === product.nameKo;
    const nameJa = normalizeText(translatedItem?.nameJa) ||
      (sameProductName ? normalizeText(archiveItem?.nameJa) : "");
    const nameEn = normalizeText(translatedItem?.nameEn) ||
      (sameProductName ? normalizeText(archiveItem?.nameEn) : "");

    if (requirements.productJa && !nameJa) {
      throw new Error(`상품 ${product.id}의 일본어 상품명 번역 결과가 비어 있습니다.`);
    }

    if (requirements.productEn && !nameEn) {
      throw new Error(`상품 ${product.id}의 영어 상품명 번역 결과가 비어 있습니다.`);
    }

    const archiveOptionMap = new Map(
      Array.isArray(archiveItem?.options)
        ? archiveItem.options.map((option) => [normalizeText(option?.id), option])
        : [],
    );
    const translatedOptionMap = new Map(
      Array.isArray(translatedItem?.options)
        ? translatedItem.options.map((option) => [normalizeText(option?.id), option])
        : [],
    );
    const options = product.options.map((option) => {
      const archiveOption = archiveOptionMap.get(option.id);
      const translatedOption = translatedOptionMap.get(option.id);
      const sameOptionName =
        archiveOption &&
        normalizeText(archiveOption.ko) === option.ko;
      const ja = normalizeText(translatedOption?.ja) ||
        (sameOptionName ? normalizeText(archiveOption?.ja) : "");
      const en = normalizeText(translatedOption?.en) ||
        (sameOptionName ? normalizeText(archiveOption?.en) : "");

      if (requirements.optionJa && !ja) {
        throw new Error(
          `상품 ${product.id}, 옵션 ${option.id}의 일본어 번역 결과가 비어 있습니다.`,
        );
      }

      if (requirements.optionEn && !en) {
        throw new Error(
          `상품 ${product.id}, 옵션 ${option.id}의 영어 번역 결과가 비어 있습니다.`,
        );
      }

      return {
        id: option.id,
        ko: option.ko,
        ja,
        en,
      };
    });

    return {
      id: product.id,
      nameKo: product.nameKo,
      nameJa,
      nameEn,
      options,
    };
  });
}

/** 기본 출력 JSON 경로를 생성한다. */
function createOutputPath(inputPath) {
  return path.join(path.dirname(inputPath), OUTPUT_FILE_NAME);
}

/** 번역 결과와 아카이브를 생성한다. */
async function translateResultDataInternal(
  json,
  {
    outputPath = "",
    signal,
    collectionMode = "general",
    openAi,
  } = {},
) {
  throwIfAborted(signal);

  const inventoryItems = getInventoryItems(json);
  const {
    products: groupedProducts,
    skippedOptions,
  } = groupInventoryItems(inventoryItems);
  const archive = await readArchive();
  const products = mergeDetailProductsWithArchive(
    groupedProducts,
    archive,
    collectionMode,
  );
  const requirements = getTranslationRequirements(collectionMode);
  const tasks = createTranslationTasks(
    products,
    archive,
    requirements,
  );
  const translations = await translateAllTasks(tasks, {
    signal,
    openAi,
  });
  const currentResults = createCurrentResults(
    products,
    archive,
    translations,
    requirements,
  );
  throwIfAborted(signal);

  if (outputPath) {
    await fs.writeFile(
      outputPath,
      `${JSON.stringify(currentResults, null, 2)}\n`,
      "utf8",
    );
  }

  const archiveUpdate = await updateProductArchive(
    currentResults,
    { source: "translation" },
  );

  console.log(`[번역 모드] ${collectionMode}`);
  console.log(`[입력 상품 row] ${inventoryItems.length}개`);
  console.log(`[그룹 상품] ${products.length}개`);
  console.log(`[신규 번역 상품] ${tasks.length}개`);
  console.log(`[건너뛴 옵션] ${skippedOptions.length}개`);

  if (outputPath) {
    console.log(`[번역 결과 저장] ${outputPath}`);
  }

  console.log(`[아카이브 저장] ${archiveUpdate.archivePath}`);

  return {
    translatedItems: currentResults,
    skippedOptions,
    taskCount: tasks.length,
    archivePath: archiveUpdate.archivePath,
    outputPath: outputPath || null,
  };
}

/** 동시 실행 시 archive.json이 덮어써지지 않게 순차 처리한다. */
function translateResultData(json, options = {}) {
  const queuedOptions = {
    ...options,
    openAi: resolveOpenAiOptions(options.openAi),
  };
  const queued = translationQueue.then(() =>
    translateResultDataInternal(json, queuedOptions),
  );

  translationQueue = queued.catch(() => undefined);

  return queued;
}

/** 명령행에서 JSON 파일을 번역한다. */
async function main() {
  const inputArgument = process.argv[2];

  if (!inputArgument) {
    throw new Error('사용법: node translate/translate.js "입력.json"');
  }

  const inputPath = path.resolve(inputArgument);
  const outputPath = createOutputPath(inputPath);
  const rawText = await fs.readFile(inputPath, "utf8");
  const json = JSON.parse(rawText.replace(/^\uFEFF/, ""));

  await translateResultData(json, {
    outputPath,
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[번역 실패]");
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  translateResultData,
};
