/**
 * page.evaluate에서 실행한다. 사이트의 실제 수량 계산 함수를 사용해
 * 각 팝업 행의 1개 적용 단가를 읽고 선택·수량·표시 상태를 복구한다.
 * 원시 할인 필드로 가격을 추정하지 않는다.
 */
function readPopupUnitPricesFromDocument() {
  const total = document.querySelector("#totalPriceSpan");
  const savedTotal = total?.innerHTML;
  const prices = Array.from(document.querySelectorAll("tr#inOptionTR")).map((row) => {
    const count = row.querySelector("input#inOPcount");
    const check = row.querySelector("input#optionCHKPOP, input[name='optionCHKPOP']");
    const stock = row.querySelector("input#inOPMaxStock");
    const price = row.querySelector("[id='htmlPricePOP']");
    const discount = row.querySelector("[id='htmlDC']");
    if (!count || !check || check.disabled || !price ||
        !(Number(stock?.value) > 0) ||
        typeof window.fnPcountCheckPop !== "function") return null;

    const saved = {
      count: count.value,
      checked: check.checked,
      price: price.innerHTML,
      discount: discount?.innerHTML,
    };
    try {
      count.value = "1";
      // 갱신되지 않은 기존 표시가를 관측값으로 취급하지 않는다.
      price.textContent = "";
      window.fnPcountCheckPop(count);
      const value = Number(price.textContent.replace(/[^\d.-]/g, ""));
      return count.value === "1" && Number.isFinite(value) && value > 0
        ? value : null;
    } catch {
      return null;
    } finally {
      count.value = saved.count;
      check.checked = saved.checked;
      price.innerHTML = saved.price;
      if (discount) discount.innerHTML = saved.discount;
    }
  });
  if (total) total.innerHTML = savedTotal;
  return prices;
}

module.exports = { readPopupUnitPricesFromDocument };
