// Deliberately failing test, to prove CI goes red. Lives only on a throwaway branch; never merged.
test('CI catches a failing test', () => {
  expect(1 + 1).toBe(3)
})
