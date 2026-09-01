const addButton = document.querySelector("#add-light")
const cartStatus = document.querySelector("#cart-status")

addButton.addEventListener("click", () => {
  cartStatus.textContent = "1 item secured"
  addButton.textContent = "Navigation light secured"
  addButton.classList.add("is-added")
})
