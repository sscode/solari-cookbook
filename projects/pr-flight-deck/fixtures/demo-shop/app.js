const addButton = document.querySelector("#add-light")
const cartStatus = document.querySelector("#cart-status")

addButton.addEventListener("click", () => {
  // Intentional demo regression: the control updates, but the manifest stays stale.
  cartStatus.textContent = "0 items secured"
  addButton.textContent = "Navigation light secured"
  addButton.classList.add("is-added")
})
